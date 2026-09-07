#!/usr/bin/env python3
"""Import the reviewed, text-only portion of the upstream exam bank.

The input is intentionally explicit: this tool does not download anything and
never lets an LLM generate or judge questions.  It accepts the
``questions/questions.json`` format from fei98/civil-service-exam-prep and
keeps every reviewed row that has a usable text stem, options, and answer.
Rows that require an image, chart, or diagram are omitted because the QQ game
surface is text-only.  Political/current-affairs material is retained in the
local source bank and marked with ``public_safe=false`` for the runtime's
separate public-content policy; it is not silently deleted by the importer.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


CATEGORY_MAP = {
    "常识判断": "common",
    "言语理解": "verbal",
    "判断推理": "reasoning",
    "数量关系": "quant",
    "资料分析": "data",
}

# This is a conservative public-chat safety filter, not a claim that every
# excluded item is unsafe in every context.  The source contains political,
# government-affairs, and current-event items that do not belong in the Bot's
# general group-chat game menu.
BLOCKED_TERMS = re.compile(
    r"习近平|共产党|中共中央|国务院|人大|政协|党政|政治|选举|民族|台湾|西藏|新疆|香港|澳门|"
    r"战争|军队|政府|公文|公务员|行政|法律|法规|宪法|刑法|民法|监察|反腐|国家安全|外交|"
    r"领土|主权|政策|领导|一国两制|宗教|人权|抗议|运动|选民|新时代|中国特色社会主义|马克思主义|"
    r"人民民主|党的二十大|党和国家|党史|党章|党建|共产主义|毛泽东|邓小平|周恩来|党的|党|"
    r"大会|省委|市委|县委|政府|总书记|重要讲话|工作报告|改革开放|行政|机构|公文|"
    r"国家|发展大会|高质量发展|新质生产力|国际形势|宏观调控"
)
VISUAL_TERMS = re.compile(
    r"下图|如图|图中|如下图|图表|表格如下|根据图|折线图|柱状图|饼图|坐标图|数独|"
    r"示意图|示意如下|图形推理|空间重构"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="upstream questions.json")
    parser.add_argument("--output", type=Path, required=True, help="local exam_bank.json")
    parser.add_argument(
        "--limit-per-category",
        type=int,
        default=0,
        help="optional deterministic cap; 0 keeps every accepted question",
    )
    return parser.parse_args()


def _text(value: Any, limit: int) -> str:
    clean = re.sub(r"[\x00-\x1f\x7f\r\n]+", " ", str(value or "")).strip()
    return re.sub(r"\s+", " ", clean)[:limit]


def convert_question(raw: dict[str, Any]) -> dict[str, Any] | None:
    category = CATEGORY_MAP.get(str(raw.get("category", "")))
    options = raw.get("options")
    answer = "".join(dict.fromkeys(re.findall(r"[A-E]", str(raw.get("answer", "")).upper())))
    stem = _text(raw.get("stem"), 12000)
    explanation = _text(raw.get("explanation"), 10000)
    raw_type = str(raw.get("type", ""))
    if (
        not category
        or raw_type not in {"single", "multiple", "judge"}
        or raw.get("reviewed") is False
        or not stem
        or not explanation
        or not isinstance(options, dict)
        or not 2 <= len(options) <= 5
        or not re.fullmatch(r"[A-E]+", answer)
        or raw.get("images")
        or raw.get("chart")
        or VISUAL_TERMS.search(stem)
    ):
        return None
    if any(letter not in options for letter in answer):
        return None
    ordered_options: list[str] = []
    for letter in "ABCDE":
        if letter in options:
            ordered_options.append(_text(options[letter], 500))
    if len(ordered_options) < 2 or any(not item for item in ordered_options):
        return None
    public_text = " ".join([stem, explanation, *ordered_options])
    return {
        "id": str(raw.get("id") or "upstream-unknown"),
        "category": category,
        "prompt": stem,
        "options": ordered_options,
        "answer": answer,
        "aliases": [
            "、".join(str(options[letter]) for letter in answer),
            " ".join(str(options[letter]) for letter in answer),
        ],
        "explanation": explanation,
        # A few upstream rows are labelled single-choice while their answer
        # field contains multiple option letters.  Preserve the row and make
        # the local judge follow the actual answer shape.
        "question_type": "multiple" if len(answer) > 1 else raw_type,
        "public_safe": not bool(BLOCKED_TERMS.search(public_text)),
        "source": "fei98/civil-service-exam-prep/questions.json",
        "source_type": str(raw.get("sourceType", "真题")),
        "source_meta": raw.get("sourceMeta") if isinstance(raw.get("sourceMeta"), dict) else {},
        "difficulty": raw.get("difficulty", 3),
        "pitfall_tags": raw.get("pitfallTags", []),
    }


def main() -> int:
    args = parse_args()
    raw = json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise SystemExit("input must be a JSON array")
    by_category: dict[str, list[dict[str, Any]]] = {key: [] for key in CATEGORY_MAP.values()}
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        converted = convert_question(item)
        if converted is None or converted["id"] in seen:
            continue
        seen.add(converted["id"])
        by_category[converted["category"]].append(converted)
    if args.limit_per_category > 0:
        by_category = {
            category: values[: args.limit_per_category]
            for category, values in by_category.items()
        }
    questions = [question for category in by_category.values() for question in category]
    if not questions:
        raise SystemExit("no accepted questions")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(questions, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    counts = Counter(question["category"] for question in questions)
    print(json.dumps({"written": len(questions), "by_category": counts}, ensure_ascii=False, default=dict))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
