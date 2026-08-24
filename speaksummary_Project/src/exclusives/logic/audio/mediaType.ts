const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp',
])

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus', 'aiff', 'alac',
])

export function isVideoFile(file: File): boolean {
  if (file.type) {
    return file.type.startsWith('video/')
  }
  const extension = file.name.split('.').pop()?.toLowerCase()
  return extension ? VIDEO_EXTENSIONS.has(extension) : false
}

export function isAcceptedMediaFile(file: File): boolean {
  if (file.type) {
    return file.type.startsWith('audio/') || file.type.startsWith('video/')
  }
  const extension = file.name.split('.').pop()?.toLowerCase()
  return extension ? AUDIO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension) : false
}
