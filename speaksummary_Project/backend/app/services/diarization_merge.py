import logging
from typing import Optional
import numpy as np
import pandas as pd
import torch
from scipy.spatial.distance import cdist

logger = logging.getLogger(__name__)


class DiarizationMerger:
    """Post-processing for diarization: centroid-merge fragmented speakers.

    Addresses the core issue: one speaker split into multiple labels due to:
    - Brief pauses within a single speaker's turn
    - Acoustic variation in long turns
    - Under-aggressive clustering in the base diarization model

    Uses speaker embeddings (wespeaker-voxceleb-resnet34-LM) to identify and merge
    clusters that belong to the same speaker.
    """

    def __init__(self, cosine_threshold: float = 0.5, min_turn_duration: float = 5.0):
        """
        Initialize the diarization merger.

        Args:
            cosine_threshold: Cosine similarity threshold for cluster merging (0-1).
                             Lower = more aggressive merging. Default 0.5 is conservative.
            min_turn_duration: Only embed segments >= this duration (seconds) to avoid noise.
        """
        self.cosine_threshold = cosine_threshold
        self.min_turn_duration = min_turn_duration
        self.embedding_model = None

    def _load_embedding_model(self):
        """Lazy-load wespeaker embedding model."""
        if self.embedding_model is None:
            try:
                # Try to load wespeaker model for speaker embeddings
                # This is a simplified approach; real implementation would use
                # the pyannote/wespeaker-voxceleb-resnet34-LM model
                logger.info("Embedding model not yet loaded (would use wespeaker for real implementation)")
                self.embedding_model = None  # Placeholder for now
            except Exception as e:
                logger.warning(f"Could not load embedding model: {e}. Skipping centroid merge.")
                self.embedding_model = False

    def merge_fragmented_speakers(
        self,
        diarize_segments: pd.DataFrame,
        embeddings: Optional[dict] = None,
    ) -> tuple[pd.DataFrame, list[tuple[str, str]]]:
        """
        Merge fragmented speaker clusters using centroid similarity.

        Args:
            diarize_segments: Diarization segments (DataFrame with 'start', 'end', 'speaker' columns)
            embeddings: Optional dict mapping speaker label -> list of embedding vectors

        Returns:
            Tuple of:
            - Merged segments (same format as input, with updated speaker labels)
            - List of (absorbed_label, merged_into_label) pairs for logging
        """
        if len(diarize_segments) == 0:
            return diarize_segments, []

        merge_pairs = []

        # If no embeddings provided, skip the merge (graceful fallback)
        if not embeddings:
            logger.debug("No embeddings provided, skipping centroid merge")
            return diarize_segments, merge_pairs

        merged_segments = diarize_segments.to_dict("records")

        # Build a mapping of speaker -> cluster_duration
        speaker_durations = {}
        for seg in merged_segments:
            speaker = seg.get("speaker")
            if speaker:
                duration = seg.get("end", 0) - seg.get("start", 0)
                speaker_durations[speaker] = speaker_durations.get(speaker, 0) + duration

        # Only process long-duration speakers (filter out noise/brief interjects)
        long_speakers = [
            spk for spk, dur in speaker_durations.items() if dur >= self.min_turn_duration
        ]

        if len(long_speakers) < 2:
            logger.debug(f"Only {len(long_speakers)} long-duration speakers; no merge needed")
            return pd.DataFrame(merged_segments), merge_pairs

        # Compute centroids for long speakers
        centroids = {}
        for speaker in long_speakers:
            if speaker in embeddings and embeddings[speaker]:
                # Average the embeddings for this speaker
                speaker_embs = np.array(embeddings[speaker])
                centroid = speaker_embs.mean(axis=0)
                centroid = centroid / (np.linalg.norm(centroid) + 1e-8)  # L2 normalize
                centroids[speaker] = centroid

        if len(centroids) < 2:
            logger.debug("Not enough speakers with embeddings for merge")
            return pd.DataFrame(merged_segments), merge_pairs

        # Compute pairwise cosine similarity and merge by transitive closure
        speakers_with_embs = list(centroids.keys())
        similarities = cdist(
            [centroids[s] for s in speakers_with_embs],
            [centroids[s] for s in speakers_with_embs],
            metric="cosine",
        )

        # Build merge graph: merge if similarity > threshold
        merge_map = {spk: spk for spk in speakers_with_embs}

        for i, spk1 in enumerate(speakers_with_embs):
            for j, spk2 in enumerate(speakers_with_embs):
                if i < j:
                    similarity = 1.0 - similarities[i, j]  # Convert distance to similarity
                    if similarity >= self.cosine_threshold:
                        # Merge spk2 into spk1 (keep the first one alphabetically or by duration)
                        root1 = merge_map[spk1]
                        root2 = merge_map[spk2]
                        if root1 != root2:
                            # Merge the shorter-duration speaker into the longer one
                            dur1 = speaker_durations.get(root1, 0)
                            dur2 = speaker_durations.get(root2, 0)
                            if dur1 >= dur2:
                                merge_map[root2] = root1
                                merge_pairs.append((root2, root1))
                                logger.info(
                                    f"Merging speaker {root2} -> {root1} "
                                    f"(similarity: {similarity:.3f})"
                                )
                            else:
                                merge_map[root1] = root2
                                merge_pairs.append((root1, root2))
                                logger.info(
                                    f"Merging speaker {root1} -> {root2} "
                                    f"(similarity: {similarity:.3f})"
                                )

        # Apply transitive closure to merge_map
        for spk in merge_map:
            visited = set()
            current = spk
            while current != merge_map[current] and current not in visited:
                visited.add(current)
                current = merge_map[current]
            merge_map[spk] = current

        # Rewrite speaker labels in merged_segments
        for segment in merged_segments:
            speaker = segment.get("speaker")
            if speaker and speaker in merge_map:
                segment["speaker"] = merge_map[speaker]

        logger.info(f"Centroid merge: {len(merge_pairs)} speaker pairs merged")
        return pd.DataFrame(merged_segments), merge_pairs


def merge_fragmented_speakers(
    diarize_segments: pd.DataFrame,
    cosine_threshold: float = 0.5,
    min_turn_duration: float = 5.0,
    embeddings: Optional[dict] = None,
) -> tuple[pd.DataFrame, list[tuple[str, str]]]:
    """Convenience function: merge fragmented speakers in diarization output.

    Args:
        diarize_segments: Diarization segments from pyannote or NeMo
        cosine_threshold: Cluster merge threshold (0-1)
        min_turn_duration: Minimum segment duration to embed (seconds)
        embeddings: Optional pre-computed speaker embeddings

    Returns:
        Tuple of (merged_segments, merge_pairs)
    """
    merger = DiarizationMerger(
        cosine_threshold=cosine_threshold,
        min_turn_duration=min_turn_duration,
    )
    return merger.merge_fragmented_speakers(diarize_segments, embeddings)
