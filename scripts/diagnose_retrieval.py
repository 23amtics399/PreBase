"""
PreBase FTS5 Retrieval Diagnostic Script
Reproduces the production retrieval failures locally.

Usage:  python scripts/diagnose_retrieval.py
"""
import sqlite3, re, os, sys

# ── helpers ─────────────────────────────────────────────────────────────────

STOP_WORDS = {
    "a","an","the","and","but","or","nor","for","yet","so",
    "in","on","at","to","of","by","up","as","is","are","was","were",
    "be","been","being","have","has","had","do","does","did",
    "will","would","shall","should","may","might","must","can","could",
    "not","no","nor","how","what","where","when","why","who","which",
    "this","that","these","those","its","it",
    "i","you","he","she","we","they","my","your","our","their",
    "am","ve","re","ll","d","s",   # contractions remnants
    "get","gets","got","go","goes",
    "with","from","about","into","than","then","them",
    "also","just","very","much","many","more","some","any",
    "if","else","like","such","each","other",
}

FTS5_OPERATORS = {"OR","AND","NOT","NEAR"}
MIN_TOKEN_LEN = 2

def sanitize_basic(raw: str) -> str | None:
    """Original sanitize: strip non-word, split, OR-join (no stop-word removal)."""
    cleaned = re.sub(r'[^\w\s]', ' ', raw)
    tokens = [t for t in cleaned.split() if len(t) >= MIN_TOKEN_LEN and t.upper() not in FTS5_OPERATORS]
    return " OR ".join(tokens) if tokens else None

def sanitize_improved(raw: str) -> tuple[str | None, str | None]:
    """
    Improved sanitize: removes stop words, tries AND-phrase first, OR fallback.
    Returns (and_query, or_query) — caller tries AND first, falls back to OR.
    """
    cleaned = re.sub(r'[^\w\s]', ' ', raw)
    all_tokens = [t for t in cleaned.split() if len(t) >= MIN_TOKEN_LEN and t.upper() not in FTS5_OPERATORS]
    # content-bearing tokens only (stop words removed)
    content_tokens = [t for t in all_tokens if t.lower() not in STOP_WORDS]

    if not content_tokens:
        # fall back to all tokens if stop-word removal wiped everything
        content_tokens = all_tokens

    if not content_tokens:
        return None, None

    # AND query: all content tokens must appear
    and_q = " AND ".join(content_tokens)
    # OR query: any content token matches (broader)
    or_q  = " OR ".join(content_tokens)
    return and_q, or_q

# ── test documents ────────────────────────────────────────────────────────

DOCS = {
    "faq": open(os.path.join(os.path.dirname(__file__), "../test_data/faq.txt"), encoding="utf-8").read(),
    "policy": open(os.path.join(os.path.dirname(__file__), "../test_data/policy.txt"), encoding="utf-8").read(),
    "mixed": open(os.path.join(os.path.dirname(__file__), "../test_data/mixed.md"), encoding="utf-8").read(),
    "business": open(os.path.join(os.path.dirname(__file__), "../test_data/business.md"), encoding="utf-8").read(),
    "bot_a": open(os.path.join(os.path.dirname(__file__), "../test_data/bot_a.txt"), encoding="utf-8").read(),
    "bot_b": open(os.path.join(os.path.dirname(__file__), "../test_data/bot_b.txt"), encoding="utf-8").read(),
}

def simple_chunk(text: str, max_chars: int = 1500, min_chars: int = 100):
    """Rough replica of the production chunker (paragraph-split)."""
    chunks = []
    current = []
    cur_len = 0
    for line in text.splitlines():
        if line.strip() == "" and cur_len >= min_chars:
            chunk = "\n".join(current).strip()
            if chunk:
                chunks.append(chunk)
            current, cur_len = [], 0
        else:
            current.append(line)
            cur_len += len(line) + 1
    if current:
        chunk = "\n".join(current).strip()
        if len(chunk) >= min_chars:
            chunks.append(chunk)
    return chunks

# ── retrieval test harness ────────────────────────────────────────────────

THRESHOLD_FIXED = -0.5  # current production threshold

FAILED_QUERIES = [
    {"bot":"faq",    "query":"Do you deliver overseas?",               "expected_hit":True},
    {"bot":"policy", "query":"How often must passwords be changed?",    "expected_hit":True},
    {"bot":"mixed",  "query":"What events are collected by default?",   "expected_hit":True},
    # These worked — include for comparison
    {"bot":"faq",    "query":"What is the return policy?",             "expected_hit":True},
    {"bot":"faq",    "query":"What is the capital of France?",         "expected_hit":False},
    {"bot":"policy", "query":"Can I work from a coffee shop without the VPN?", "expected_hit":True},
    {"bot":"mixed",  "query":"How do I disable auto-tracking?",        "expected_hit":True},
]

def run_query(db, bot_id, fts_query):
    try:
        rows = db.execute(
            "SELECT content, bm25(kb_fts) as score FROM kb_fts WHERE kb_fts MATCH ? AND bot_id = ? ORDER BY score ASC LIMIT 10",
            (fts_query, bot_id)
        ).fetchall()
        return rows
    except Exception as e:
        return [("ERROR", str(e))]

def build_db():
    db = sqlite3.connect(":memory:")
    db.execute("CREATE VIRTUAL TABLE kb_fts USING fts5(bot_id UNINDEXED, content)")
    for bot_id, text in DOCS.items():
        chunks = simple_chunk(text)
        for chunk in chunks:
            db.execute("INSERT INTO kb_fts(bot_id, content) VALUES (?, ?)", (bot_id, chunk))
    db.commit()
    return db

def analyse():
    db = build_db()

    # show corpus stats
    print("="*70)
    print("CORPUS STATISTICS")
    print("="*70)
    for bot_id, text in DOCS.items():
        chunks = simple_chunk(text)
        print(f"  {bot_id:12s}: {len(chunks)} chunks, {len(text)} chars")

    print()
    print("="*70)
    print("RETRIEVAL DIAGNOSIS")
    print("="*70)

    for case in FAILED_QUERIES:
        bot = case["bot"]
        query = case["query"]
        expected = case["expected_hit"]

        q_basic   = sanitize_basic(query)
        q_and, q_or = sanitize_improved(query)

        print(f"\n{'─'*70}")
        print(f"  Bot    : {bot}")
        print(f"  Query  : {query}")
        print(f"  Expect : {'ANSWER' if expected else 'FALLBACK'}")
        print(f"  Basic FTS query  : {q_basic}")
        print(f"  Improved AND     : {q_and}")
        print(f"  Improved OR      : {q_or}")

        # --- Basic strategy (current production) ---
        rows_basic = run_query(db, bot, q_basic) if q_basic else []
        print(f"\n  [BASIC OR] candidates (threshold={THRESHOLD_FIXED}):")
        passed_basic = False
        if not rows_basic:
            print("    → NO CANDIDATES (FTS5 returned empty)")
        for content, score in rows_basic:
            if isinstance(score, float):
                passes = score <= THRESHOLD_FIXED
                marker = "✓ PASS" if passes else "✗ FAIL"
                if passes:
                    passed_basic = True
                print(f"    [{marker}] score={score:.6f}  chunk={repr(content[:80])}")
            else:
                print(f"    ERROR: {score}")

        # --- Improved AND strategy ---
        rows_and = run_query(db, bot, q_and) if q_and else []
        print(f"\n  [IMPROVED AND] candidates:")
        passed_and = False
        if not rows_and:
            print("    → NO CANDIDATES (AND query returned empty — will fall back to OR)")
        for content, score in rows_and:
            if isinstance(score, float):
                passes = score <= THRESHOLD_FIXED
                marker = "✓ PASS" if passes else "✗ FAIL"
                if passes:
                    passed_and = True
                print(f"    [{marker}] score={score:.6f}  chunk={repr(content[:80])}")

        # --- Improved OR fallback strategy ---
        rows_or = run_query(db, bot, q_or) if q_or else []
        print(f"\n  [IMPROVED OR fallback] candidates:")
        passed_or = False
        if not rows_or:
            print("    → NO CANDIDATES")
        for content, score in rows_or:
            if isinstance(score, float):
                # adaptive threshold: pass if within 2x the best score, or absolute threshold
                best = rows_or[0][1] if rows_or else 0
                passes = score <= THRESHOLD_FIXED or (best < -0.01 and score <= best * 0.5)
                marker = "✓ PASS" if passes else "✗ FAIL"
                if passes:
                    passed_or = True
                print(f"    [{marker}] score={score:.6f}  chunk={repr(content[:80])}")

        print(f"\n  RESULT: basic={passed_basic} | improved_and={passed_and} | improved_or={passed_or}")
        if not passed_basic and (passed_and or passed_or):
            print("  ⚠ FIX NEEDED: basic strategy misses this, improved catches it")
        elif not passed_basic and not passed_and and not passed_or:
            print("  ✗ SEMANTIC GAP: FTS5 cannot retrieve this — true limitation")

    print()

if __name__ == "__main__":
    analyse()
