"""
analyze.py — standalone Python text-analysis script.

This works perfectly as a standalone script, but the goal is to
call it from TypeScript via Stitch.

Run it directly to verify:
    python3 analyze.py data/sample.txt
"""

import re
import sys
import collections
import math


def word_count(text: str) -> int:
    """Total number of words."""
    return len(re.findall(r"\b\w+\b", text.lower()))


def sentence_count(text: str) -> int:
    """Approximate sentence count (splits on . ! ?)."""
    sentences = re.split(r"[.!?]+", text.strip())
    return len([s for s in sentences if s.strip()])


def top_words(text: str, n: int = 10) -> list:
    """Return top-N words by frequency, excluding common stopwords."""
    stopwords = {
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
        "for", "of", "with", "by", "from", "is", "it", "that", "this",
        "as", "are", "was", "be", "have", "has", "not", "its", "which",
        "about", "more", "all", "than", "yet", "might", "they", "their",
        "what", "some", "when", "how", "into", "both", "other",
    }
    words = re.findall(r"\b[a-z]{3,}\b", text.lower())
    filtered = [w for w in words if w not in stopwords]
    counter = collections.Counter(filtered)
    return [[word, count] for word, count in counter.most_common(n)]


def readability(text: str) -> float:
    """
    Flesch Reading Ease score (0–100, higher = easier).
    Formula: 206.835 - 1.015*(words/sentences) - 84.6*(syllables/words)
    """
    words = re.findall(r"\b\w+\b", text.lower())
    if not words:
        return 0.0
    n_words = len(words)
    n_sentences = max(sentence_count(text), 1)
    n_syllables = sum(_syllable_count(w) for w in words)
    score = 206.835 - 1.015 * (n_words / n_sentences) - 84.6 * (n_syllables / n_words)
    return round(max(0.0, min(100.0, score)), 1)


def summarize(text: str) -> dict:
    """Return all stats in one call."""
    words = re.findall(r"\b\w+\b", text.lower())
    unique = len(set(words))
    return {
        "word_count": word_count(text),
        "sentence_count": sentence_count(text),
        "unique_words": unique,
        "readability_score": readability(text),
        "top_words": top_words(text, 5),
    }


def _syllable_count(word: str) -> int:
    """Rough syllable count using vowel-group heuristic."""
    word = word.lower().rstrip("e")
    return max(1, len(re.findall(r"[aeiou]+", word)))


# ── CLI entry-point (for standalone testing) ──────────────────────────────────

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "data/sample.txt"
    with open(path) as f:
        text = f.read()

    stats = summarize(text)
    print(f"Words          : {stats['word_count']}")
    print(f"Sentences      : {stats['sentence_count']}")
    print(f"Unique words   : {stats['unique_words']}")
    print(f"Readability    : {stats['readability_score']} / 100")
    print(f"Top words      : {', '.join(w for w, _ in stats['top_words'])}")
