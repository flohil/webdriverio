/**
 *
 * protocol bindings for all geolocation operations
 *
 * ### Usage
 *
 *     // get the current geo location
 *     client.location(function(err,res) { ... });
 *
 *     // set the current geo location
 *     client.location({latitude: 121.21, longitude: 11.56, altitude: 94.23})
 *
 * @param {Object} location  the new location
 * @returns {Object}         the current geo location
 *
 * @see  https://code.google.com/p/selenium/wiki/JsonWireProtocol#/session/:sessionId/location
 *
 */

module.exports = function location (l) {
    var data = {};

    if (typeof l === 'object' && l.latitude && l.longitude && l.altitude) {
        data = l;
    }

    this.requestHandler.create(
        '/session/:sessionId/location',
        data,
        arguments[arguments.length - 1]
    );
};
