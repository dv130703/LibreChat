"""Test embedding and reranking functions with dummy data."""

from config import embed_document, PROCESSING_MACHINE
import requests

def test_embedding():
    """Test the embedding function with sample text."""
    print("=" * 60)
    print("TESTING EMBEDDING FUNCTION")
    print("=" * 60)

    sample_texts = [
        "The quick brown fox jumps over the lazy dog",
        "Machine learning is transforming the world",
        "Python is a great programming language"
    ]

    for text in sample_texts:
        try:
            print(f"\nEmbedding: '{text}'")
            embedding = embed_document(text)
            print(f"✓ Success! Embedding shape: {len(embedding)} dimensions")
            print(f"  First 5 values: {embedding[:5]}")
        except Exception as e:
            print(f"✗ Error: {e}")


def test_reranking():
    """Test reranking with sample query and documents."""
    print("\n" + "=" * 60)
    print("TESTING RERANKING FUNCTION")
    print("=" * 60)

    query = "What is machine learning?"
    documents = [
        "Machine learning is a subset of artificial intelligence",
        "Dogs are loyal pets",
        "Python is used for data science and ML",
        "The weather is sunny today",
        "Deep learning uses neural networks for learning patterns"
    ]

    print(f"\nQuery: '{query}'")
    print(f"\nDocuments to rerank:")
    for i, doc in enumerate(documents, 1):
        print(f"  {i}. {doc}")

    # Try to rerank using the Ollama endpoint
    try:
        print("\nSending rerank request...")
        response = requests.post(
            f"{PROCESSING_MACHINE}/rerank",
            json={
                "model": "jina-reranker-v2-base-multilingual",
                "query": query,
                "documents": documents
            }
        )

        if response.status_code == 200:
            result = response.json()
            print("✓ Reranking successful!")
            print(f"  Response: {result}")
        else:
            print(f"✗ Error: {response.status_code}")
            print(f"  Response: {response.text}")
    except Exception as e:
        print(f"✗ Error: {e}")
        print("  (Make sure your reranker model is available on Ollama)")


if __name__ == "__main__":
    test_embedding()
    test_reranking()
