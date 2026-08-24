/**
 * Type definitions for the Session API (Tier 2.0 backend).
 * Mirrors the backend schemas but for frontend consumption.
 */

export interface WordToken {
  text: string
  start: number | null
  end: number | null
  confidence?: number | null
  speaker?: string | null
  speaker_overlap?: boolean
  is_alignment_gap?: boolean
}

export interface TranscriptSegment {
  id: string
  start: number
  end: number
  speaker: string
  text: string
  words?: WordToken[] | null
  avg_confidence?: number | null
}

export interface TranscriptionDiagnostics {
  alignment_gap_count: number
  alignment_gap_total_s: number
  low_confidence_word_count: number
  diarization_backend: string
  diarization_speaker_count: number
  vad_speech_ratio: number
}

export interface TranscriptionProvenance {
  audio_sha256: string
  asr_artifact_sha256: string
  diar_artifact_sha256s: string[]
  preprocessing_applied: string[]
  pipeline_version: string
}

export interface TranscriptionResponse {
  segments: TranscriptSegment[]
  language: string
  file_sha256: string
  diagnostics?: TranscriptionDiagnostics | null
  provenance?: TranscriptionProvenance | null
}

export interface ChannelMode {
  mode: 'mono' | 'stereo_duplicate' | 'stereo_distinct' | 'per_channel'
  description: string
  num_discrete_channels: number
  correlation?: number | null
}

export interface AudioStream {
  index: number
  codec: string
  channels: number
  channel_layout?: string | null
  sample_rate: number
  bit_rate?: number | null
  duration_s?: number | null
}

export interface ClippingAnalysis {
  clipping_percentage: number
  max_consecutive_clipped_samples: number
  clipping_event_count: number
  has_significant_clipping: boolean
}

export interface AudioQualityAssessment {
  rating: 'good' | 'acceptable' | 'poor' | 'very_poor'
  description: string
  should_adjust_gain: boolean
  show_clipping_warning: boolean
}

export interface AudioQualityMetrics {
  speech_duration_s?: number | null
  silence_duration_s?: number | null
  speech_ratio?: number | null
  peak_level_db?: number | null
  rms_level_db?: number | null
  vad_detected_speech_db?: number | null
  vad_detected_noise_db?: number | null
  lufs_integrated: number | null
  lufs_short_term?: number | null
  loudness_range_lu?: number | null
  clipping: ClippingAnalysis | null
  bandwidth_hz: number | null
  reverb_c50_proxy: number | null
  codec_provenance?: Record<string, unknown> | null
  assessment?: AudioQualityAssessment | null
}

export interface Manifest {
  audio_sha256: string
  original_filename: string
  size_bytes: number
  container: string
  duration_s: number
  ingested_at: string
  ingested_by?: string | null
  pipeline_version: string
  channel_mode: ChannelMode
  streams: AudioStream[]
  quality_metrics: AudioQualityMetrics | null
  audio_artifact_path?: string | null
  audio_artifact_sha256?: string | null
  asr_artifact_path?: string | null
  asr_artifact_sha256?: string | null
  diar_artifact_paths: string[]
  diar_artifact_sha256s: string[]
  vad_timeline_path: string | null
  preferred_asr_artifact: 'original' | 'preprocessed'
}
