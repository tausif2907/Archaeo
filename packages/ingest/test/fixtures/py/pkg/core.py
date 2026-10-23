import os
import typing as t
from . import utils
from .utils import slugify, Helper
from ..shared.config import load_config


def top_level(name):
    if not name or name == "x":
        return slugify(name)
    return helper_two(name)


def helper_two(value):
    return [v for v in value if v]


class Command:
    """A command."""

    def __init__(self, name):
        self.name = name

    @property
    def title(self):
        return self.name.title()

    def invoke(self, ctx):
        try:
            return self.run(ctx)
        except ValueError:
            return Helper().fallback(ctx)

    def run(self, ctx):
        def inner():
            return top_level(ctx)

        return inner() if ctx else None
