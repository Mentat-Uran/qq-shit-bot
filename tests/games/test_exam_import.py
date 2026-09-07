import importlib.util
from pathlib import Path
import sys


MODULE_PATH = Path(__file__).resolve().parents[2] / "tools" / "import_exam_bank.py"
SPEC = importlib.util.spec_from_file_location("qqbot_exam_import", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
IMPORTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = IMPORTER
SPEC.loader.exec_module(IMPORTER)


def row(**overrides):
    value = {
        "id": "fixture-1",
        "category": "常识判断",
        "type": "single",
        "reviewed": True,
        "stem": "下列哪项正确？",
        "options": {"A": "甲", "B": "乙", "C": "丙", "D": "丁"},
        "answer": "A",
        "explanation": "这是固定 fixture 解析。",
    }
    value.update(overrides)
    return value


def test_importer_keeps_text_only_multiple_answers_and_marks_public_policy():
    multiple = IMPORTER.convert_question(row(id="multiple", type="multiple", answer="B,D"))
    assert multiple is not None
    assert multiple["answer"] == "BD"
    assert multiple["question_type"] == "multiple"

    unsafe = IMPORTER.convert_question(row(id="unsafe", stem="某政治机构的历史题"))
    assert unsafe is not None
    assert unsafe["public_safe"] is False
    option_unsafe = IMPORTER.convert_question(
        row(id="option-unsafe", options={"A": "某政治机构", "B": "乙", "C": "丙", "D": "丁"})
    )
    assert option_unsafe is not None
    assert option_unsafe["public_safe"] is False


def test_importer_drops_only_visual_dependencies_at_the_text_filter_boundary():
    visual = IMPORTER.convert_question(row(id="visual", stem="如下图所示，选择正确项。"))
    assert visual is None

    malformed = IMPORTER.convert_question(row(id="bad-answer", answer="Z"))
    assert malformed is None
