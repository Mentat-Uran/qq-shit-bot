import datetime
import os
import sqlite3
import sys
import time
from pathlib import Path


DB_PATH = Path(os.environ["LOCALAPPDATA"]) / "hermes" / "state.db"


def query(sql, params=()):
    uri = DB_PATH.resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=3)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=3000")
    try:
        return connection.execute(sql, params).fetchall()
    finally:
        connection.close()


def format_time(timestamp):
    if not timestamp:
        return "--:--:--"
    timestamp = timestamp / 1000 if timestamp > 100_000_000_000 else timestamp
    return datetime.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")


def main():
    if not DB_PATH.exists():
        print(f"找不到 Hermes 数据库：{DB_PATH}")
        input("按回车键退出……")
        return 1

    last_id = query(
        """
        SELECT COALESCE(MAX(m.id), 0)
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE s.source = 'qqbot'
        """
    )[0][0]

    print("正在监控新的 QQ 消息、BOT 回复和模型保存的推理，Ctrl+C 退出。", flush=True)

    while True:
        try:
            rows = query(
                """
                SELECT
                    m.id,
                    m.timestamp,
                    m.role,
                    COALESCE(m.content, ''),
                    COALESCE(m.reasoning_content, ''),
                    COALESCE(m.tool_name, ''),
                    COALESCE(m.tool_calls, '')
                FROM messages m
                JOIN sessions s ON s.id = m.session_id
                WHERE s.source = 'qqbot' AND m.id > ?
                ORDER BY m.id
                """,
                (last_id,),
            )

            for message_id, timestamp, role, content, reasoning, tool_name, tool_calls in rows:
                clock = format_time(timestamp)

                if reasoning.strip():
                    print(f"\n[{clock}] 模型返回的推理\n{reasoning.strip()}", flush=True)

                if tool_calls.strip():
                    print(f"\n[{clock}] 工具调用\n{tool_calls.strip()}", flush=True)

                if role == "user" and content.strip():
                    print(f"\n[{clock}] 群消息\n{content.strip()}", flush=True)
                elif role == "assistant" and content.strip():
                    print(f"\n[{clock}] BOT 回复\n{content.strip()}", flush=True)
                elif role == "tool" and content.strip():
                    print(
                        f"\n[{clock}] 工具结果 {tool_name}\n{content.strip()[:2000]}",
                        flush=True,
                    )

                last_id = message_id

            time.sleep(0.5)
        except sqlite3.Error as error:
            print(f"\n数据库暂时不可读：{error}；3 秒后重试。", flush=True)
            time.sleep(3)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n监控已停止。")

