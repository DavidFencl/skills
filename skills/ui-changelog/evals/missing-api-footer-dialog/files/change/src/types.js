// @ts-check
// Response shapes of the club API.

/**
 * @typedef {'easy' | 'moderate' | 'hard'} Difficulty
 */

/**
 * @typedef {object} RunEvent
 * @property {string} id
 * @property {string} title
 * @property {string} startsAt ISO date-time
 * @property {string} city
 * @property {number} distanceKm
 * @property {Difficulty} difficulty
 * @property {number} spotsLeft
 * @property {boolean} isFull
 * @property {string} [coverImageUrl]
 */

/**
 * @typedef {object} EventPage
 * @property {RunEvent[]} items
 * @property {number} total
 * @property {number} page
 * @property {number} pageSize
 */

/**
 * @typedef {object} ClubStats
 * @property {number} memberCount
 * @property {number} eventsThisYear
 * @property {number} kilometersRun
 * @property {number} countryCount
 */

/**
 * @typedef {object} Viewer
 * @property {string} id
 * @property {string} displayName
 * @property {string} avatarUrl
 * @property {string} memberSince ISO date
 */

/**
 * @typedef {object} ViewerQueryResult
 * @property {{ viewer: Viewer }} data
 */

/**
 * @typedef {object} PresenceMessage
 * @property {'presence'} type
 * @property {number} online
 */

/**
 * @typedef {object} SupportReportInput
 * @property {string} description
 * @property {string} [email]
 * @property {string} page
 */

/**
 * @typedef {object} SupportReportReceipt
 * @property {string} reportId
 * @property {string} receivedAt ISO date-time
 */

export {};
