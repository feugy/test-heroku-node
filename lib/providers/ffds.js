
const request = require('request-promise-native')
const moment = require('moment')
const cheerio = require('cheerio')
const Joi = require('joi')
const md5 = require('md5')
const {
  filter,
  flatten,
  flow,
  map,
  uniq
} = require('lodash/fp')
const {slugify, stripTags, titleize} = require('underscore.string.fp')
const {sprintf} = require('sprintf-js')
const Competition = require('../models/competition')
const Provider = require('./provider')
const {
  handleRequestError,
  mergeCompetitions,
  removeAccents,
  replaceUnallowed,
  runSerially
} = require('../utils')

const optsSchema = Joi.object({
  clubs: Joi.string().required(),
  couples: Joi.string().required(),
  details: Joi.string().required(),
  search: Joi.string().required()
}).required().unknown().label('opts')

/**
 * Make names to begin with first name, without accentuated letters and capitalized.
 *
 * @param {String} names - contains html text with dancers names, separated by a <br> tag
 * @return {String} the correctly formated name string
 */
const cleanNames = names => {
  if (/couple inconnu/.test(names.toLowerCase())) {
    return 'couple inconnu'
  }
  // split both dancers
  const results = names.split('<br>').map(raw => {
    // remove remaining html
    const dancer = stripTags(raw)
    // extract first name (always in upper cas)
    let last = ''
    let first = ''
    let prevUpper = false
    Array.from(dancer).forEach((char, i) => {
      const code = dancer.charCodeAt(i)
      if ((code >= 65 && code <= 90) || (code >= 192 && code <= 221)) {
        // Uppercase symbol
        // A: 65 Z: 90 À: 192 Ý: 221
        last += char
        prevUpper = true
      } else if ([32, 39, 45].includes(code)) {
        // Separation symbol
        // ': 39 -: 45 ' ':32
        if (prevUpper) {
          last += char
        } else {
          first += char
        }
        prevUpper = false
      } else {
        // Lowercase symbol
        if (prevUpper) {
          last = last.slice(0, last.length - 1)
          first += dancer.slice(i - 1, i + 1)
          prevUpper = false
        } else {
          first += char
        }
      }
    })
    // capitalize and remove accentuated letters
    return `${removeAccents(first)} ${removeAccents(last)}`
  })
  return `${titleize(results[0])} - ${titleize(results[1])}`
}

/**
 * Remove useless information from contest titles
 *
 * @param {String} original - original contest title
 * @returns {String} its cleanned version
 */
const cleanContest = original =>
  original.replace('Compétition à points', '').replace('Compétition sans points', '').trim()

/**
 * Check if a date is first half of the year (before august 14th, included)
 *
 * @param {Moment} date - checked date
 * @returns {Boolean} true if this date is before august 14th, included, false otherwise
 */
const isFirstHalf = date =>
  date.month() < 7 || (date.month() === 7 && date.date() <= 14)

/**
 * Check if a given year match current season, or is archive
 *
 * @param {year} Number - current season year, always smaller (one from september)
 * @param {Moment} date - checked date
 * @returns {Boolean} true if date is current year and in second half, or if date is next year and first half
 */
const isWithinSeason = (year, date) =>
  (year === date.year() && !isFirstHalf(date)) || (year + 1 === date.year() && isFirstHalf(date))

/**
 * Extract couple names from a club or search result Html response
 *
 * @param {String} body - the Html response
 * @returns {Array<String>} resolve with list of strings containing the couple names (may be empty).
 */
const extractNames = body => {
  const $ = cheerio.load(replaceUnallowed(body.toString()), {decodeEntities: false})
  return Array.from($('#tosort tbody tr')).map(couple => {
    try {
      return cleanNames($(couple).find('td:first-child').text().trim().replace(' / ', '<br>'))
    } catch (exc) {
      throw new Error(`failed to parse couple names '${couple}': ${exc}`)
    }
  })
}

/**
 * Extract a competition header (place, date, url) from incoming Html
 * Ignore competitions whose date is not in current season
 * If multiple competitions are found at the same date and place, enrich existing competition to ensure uniquness
 *
 * @param {Object} line - cheerio object of incoming Html
 * @param {Object} opts - options used to configure extraction:
 * @param {String} opts.dateFormat -
 * @param {String} opts.url -
 * @param {String} opts.details -
 * @returns {Competition} extracted competition, may be undefined
 */
const extractHeader = (line, opts, year) => {
  // extract id to consult details
  const href = line.find('td:last-child a').attr('href')
  if (!href) {
    return
  }
  const id = href.match(/NumManif=(\d+)$/)
  if (!id) {
    return
  }
  const data = {
    place: titleize(line.find('td').eq(0).text().trim().toLowerCase()),
    date: moment(line.find('td').eq(1).text(), opts.dateFormat),
    url: sprintf(`${opts.url}/${opts.details}`, id[1]),
    provider: 'ffds'
  }
  // only keep competition in current year after mid august, or next year before mid august
  if (!isWithinSeason(year, data.date)) {
    return
  }
  // removes parenthesis information if present
  data.place = data.place.replace(/\(\s*\w+\s*\)/, '').trim()
  // id is date append to place lowercased without non-word characters.
  data.id = md5(`${slugify(data.place)}${data.date.format('YYYYMMDD')}`)
  // search for existing competition with same url
  return new Competition(data)
}

/**
 * Extract a competition's contest ranking from contest's id.
 * The competition's contests attribute will be added extracted ranking
 *
 * @param {String} url - full url of the contest ranking
 * @returns {Promise<Object>} extracted ranking; object with title and results
 */
const extractRanking = url =>
  request({
    // to avoid encoding problems
    encoding: 'binary',
    url
  }).then(bodyRaw => {
    // remove errored divs
    const body = replaceUnallowed(bodyRaw.toString())
      .replace(/<\/div><\/th>/g, '</th>')
    // extract ranking
    const $ = cheerio.load(body, {decodeEntities: false})
    const results = {}
    const title = cleanContest($('h3').text())
    // WARNING! cheerio's each has different parameter from forEach
    // first heat is final
    $('.portlet').each((i, heat) =>
      $(heat).find('tbody > tr').each((j, row) => {
        try {
          const names = cleanNames($(row).find('td:nth-child(3)').html())
          if (!(names in results)) {
            results[names] = parseInt($(row).find('td:nth-child(1)').text())
          }
        } catch (exc) {
          throw new Error(`failed to parse ranking '${title}' heat ${i * 2}: ${exc}`)
        }
      })
    )
    return {title, results}
  })

/**
 * Extract national competitions from the Ballroom Dancing National Federation
 */
module.exports = class FFDSProvider extends Provider {
  /**
   * Provider constructor: initialize with configuration
   * For mandatory options, @see Provider.constructor
   *
   * @param {Object} opts - provider configuration. Must contains:
   * @param {String} opts.clubs - url to list exsting clubs
   * @param {String} opts.couples - url to list couples of a given club
   * @param {String} opts.details - url to get competition details
   * @param {String} opts.search - url to search for couples
   */
  constructor (opts) {
    super(opts)
    // Club list, to avoid asking too many time them
    this.clubs = null

    // Provider configuration options. @see constructor
    const {error} = Joi.validate(opts, optsSchema)
    if (error) {
      throw error
    }
  }

  /**
   * @see Provider.listResults()
   */
  listResults (year) {
    const url = `${this.opts.url}/${this.opts.list}${isWithinSeason(year, moment()) ? '' : '?Archives'}`
    // performs itself the request
    return request({
      // to avoid encoding problems
      encoding: 'binary',
      url
    }).then(body => {
      // extract competiton headers for each lines
      const $ = cheerio.load(replaceUnallowed(body.toString()), {decodeEntities: false})
      return mergeCompetitions(
        Array.from($('table#tosort > tbody > tr'))
          .map(line => extractHeader($(line), this.opts, year))
      )
    }).catch(handleRequestError(`failed to fetch results from ${this.opts.name}`))
  }

  /**
   * @see Provider.getDetails()
   */
  getDetails (competition) {
    // request contests list, for each known urls
    return runSerially(competition.dataUrls.map(url => () =>
      request({
        // to avoid encoding problems
        encoding: 'binary',
        url
      }).then(body => {
        // extract contests ranking ids
        const $ = cheerio.load(replaceUnallowed(body.toString()), {decodeEntities: false})
        return Array.from($('td > a')).map(link => `${this.opts.url}/${$(link).attr('href')}`)
      }).catch(handleRequestError(`failed to fetch contests from ${this.opts.name} ${competition.place}`))
    )).then(rawUrls => {
      const urls = flow(flatten, uniq)(rawUrls)
      competition.contests = []
      // no contests yet
      if (!urls.length) {
        return competition
      }

      // get all contests rankings
      return runSerially(urls.map(url => () =>
        extractRanking(url)
          .catch(handleRequestError(`failed to fetch contest ranking from ${this.opts.name} ${competition.place}`))
      )).then(contests => {
        competition.contests = contests
        return competition
      })
    })
  }

  /**
   * @see Provider.searchGroups()
   */
  searchGroups (searched = '') {
    const searchedStr = searched.trim().toLowerCase()

    // once clubs were retireved, search inside
    const search = () =>
      flow(
        filter(club => club.name.toLowerCase().includes(searchedStr)),
        map('name')
      )(this.clubs)

    // immediately search if clubs are already available
    if (this.clubs) {
      return Promise.resolve(search())
    }

    // get club ids and names
    return request({
      // to avoid encoding problems
      encoding: 'binary',
      url: `${this.opts.url}/${this.opts.clubs}`
    }).then(body => {
      // extract club ids and names and store it in memory
      const $ = cheerio.load(replaceUnallowed(body.toString()), {decodeEntities: false})
      this.clubs = Array.from($('[name=club_id] option'))
        .map(club => ({id: $(club).attr('value'), name: $(club).text().trim()}))
      return search()
    }).catch(handleRequestError(`failed to fetch group list from ${this.opts.name}`))
  }

  /**
   * @see Provider.getCouples()
   */
  getGroupCouples (group) {
    const err = Joi.string().empty().required().label('group parameter').validate(group).error
    if (err) {
      return Promise.reject(err)
    }

    // once clubs were retrieved, search inside
    const search = () => {
      // get club id
      const club = this.clubs.find(club => club.name.toLowerCase() === group.trim().toLowerCase())
      if (!club) {
        return Promise.reject(new Error(`no group found with name ${group}`))
      }
      // now get its couples
      return request({
        // to avoid encoding problems
        encoding: 'binary',
        url: sprintf(`${this.opts.url}/${this.opts.couples}`, club.id)
      }).then(extractNames)
        .catch(handleRequestError(`failed to fetch couples of group ${group} from ${this.opts.name}`))
    }

    // immediately search if clubs are available, populate clubs with empty search otherwise
    if (this.clubs) {
      return search()
    }
    return this.searchGroups('')
      .then(search)
  }

  /**
   * @see Provider.searchCouples()
   */
  searchCouples (searched = '') {
    return request({
      // to avoid encoding problems
      encoding: 'binary',
      url: sprintf(`${this.opts.url}/${this.opts.search}`, encodeURIComponent(searched.toUpperCase()))
    }).then(extractNames)
      .catch(handleRequestError(`failed to fetch couples from ${this.opts.name}`))
  }
}