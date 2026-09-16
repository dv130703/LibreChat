const handleText = require('./handleText');
const sendEmail = require('./sendEmail');
const files = require('./files');

module.exports = {
  ...handleText,
  sendEmail,
  ...files,
};
