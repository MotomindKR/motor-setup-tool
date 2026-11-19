"""Localized worker messages. Protocol fields and register values stay language independent."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import cache
import json
from pathlib import Path

_locale = ContextVar("dxl_locale", default="en")


@contextmanager
def language(locale):
    token = _locale.set(locale)
    try:
        yield
    finally:
        _locale.reset(token)


@cache
def _korean():
    return json.loads(Path(__file__).with_name("ko.json").read_text(encoding="utf-8"))


def translate(message, **values):
    if _locale.get() == "ko":
        message = _korean().get(message, message)
    return message.format(**values) if values else message
