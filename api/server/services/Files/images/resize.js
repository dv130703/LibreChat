const sharp = require('sharp');

/** sharp defaults to `failOn: 'warning'`, which aborts on libvips/libpng
 * warnings that browsers and OS screenshot tools happily ignore (e.g. minor
 * chunk/CRC nonconformance) - real, renderable screenshots then 500 here
 * instead of being resized. Matches the tolerance a browser already gives
 * these files. */
const INPUT_OPTIONS = { failOn: 'none' };

/**
 * Resizes an image from a given buffer based on the specified resolution.
 *
 * @param {Buffer} inputBuffer - The buffer of the image to be resized.
 * @param {'low' | 'high' | {percentage?: number, px?: number}} resolution - The resolution to resize the image to.
 *                                      'low' for a maximum of 512x512 resolution,
 *                                      'high' for a maximum of 768x2000 resolution,
 *                                      or a custom object with percentage or px values.
 * @returns {Promise<{buffer: Buffer, width: number, height: number}>} An object containing the resized image buffer and its dimensions.
 * @throws Will throw an error if the resolution parameter is invalid.
 */
async function resizeImageBuffer(inputBuffer, resolution) {
  const maxLowRes = 512;
  const maxShortSideHighRes = 768;
  const maxLongSideHighRes = 2000;

  let customPercent, customPx;
  if (resolution && typeof resolution === 'object') {
    if (typeof resolution.percentage === 'number') {
      customPercent = resolution.percentage;
    } else if (typeof resolution.px === 'number') {
      customPx = resolution.px;
    }
  }

  let newWidth, newHeight;
  let resizeOptions = { fit: 'inside', withoutEnlargement: true };

  if (customPercent != null || customPx != null) {
    // percentage-based resize
    const metadata = await sharp(inputBuffer, INPUT_OPTIONS).metadata();
    if (customPercent != null) {
      newWidth = Math.round(metadata.width * (customPercent / 100));
      newHeight = Math.round(metadata.height * (customPercent / 100));
    } else {
      // pixel max on both sides
      newWidth = Math.min(metadata.width, customPx);
      newHeight = Math.min(metadata.height, customPx);
    }
    resizeOptions.width = newWidth;
    resizeOptions.height = newHeight;
  } else if (resolution === 'low') {
    resizeOptions.width = maxLowRes;
    resizeOptions.height = maxLowRes;
  } else if (resolution === 'high') {
    const metadata = await sharp(inputBuffer, INPUT_OPTIONS).metadata();
    const isWidthShorter = metadata.width < metadata.height;

    if (isWidthShorter) {
      // Width is the shorter side
      newWidth = Math.min(metadata.width, maxShortSideHighRes);
      // Calculate new height to maintain aspect ratio
      newHeight = Math.round((metadata.height / metadata.width) * newWidth);
      // Ensure the long side does not exceed the maximum allowed
      if (newHeight > maxLongSideHighRes) {
        newHeight = maxLongSideHighRes;
        newWidth = Math.round((metadata.width / metadata.height) * newHeight);
      }
    } else {
      // Height is the shorter side
      newHeight = Math.min(metadata.height, maxShortSideHighRes);
      // Calculate new width to maintain aspect ratio
      newWidth = Math.round((metadata.width / metadata.height) * newHeight);
      // Ensure the long side does not exceed the maximum allowed
      if (newWidth > maxLongSideHighRes) {
        newWidth = maxLongSideHighRes;
        newHeight = Math.round((metadata.height / metadata.width) * newWidth);
      }
    }

    resizeOptions.width = newWidth;
    resizeOptions.height = newHeight;
  } else {
    throw new Error('Invalid resolution parameter');
  }

  const resizedBuffer = await sharp(inputBuffer, INPUT_OPTIONS)
    .rotate()
    .resize(resizeOptions)
    .toBuffer();

  const resizedMetadata = await sharp(resizedBuffer).metadata();
  return {
    buffer: resizedBuffer,
    bytes: resizedMetadata.size,
    width: resizedMetadata.width,
    height: resizedMetadata.height,
  };
}

/**
 * Resizes an image buffer to a specified format and width.
 *
 * @param {Object} options - The options for resizing and converting the image.
 * @param {Buffer} options.inputBuffer - The buffer of the image to be resized.
 * @param {string} options.desiredFormat - The desired output format of the image.
 * @param {number} [options.width=150] - The desired width of the image. Defaults to 150 pixels.
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, bytes: number }>} An object containing the resized image buffer, its size, and dimensions.
 * @throws Will throw an error if the resolution or format parameters are invalid.
 */
async function resizeAndConvert({ inputBuffer, desiredFormat, width = 150 }) {
  const resizedBuffer = await sharp(inputBuffer, INPUT_OPTIONS)
    .resize({ width })
    .toFormat(desiredFormat)
    .toBuffer();
  const resizedMetadata = await sharp(resizedBuffer).metadata();
  return {
    buffer: resizedBuffer,
    width: resizedMetadata.width,
    height: resizedMetadata.height,
    bytes: Buffer.byteLength(resizedBuffer),
  };
}

module.exports = { resizeImageBuffer, resizeAndConvert };
