def slugify(text):
    return text.lower().replace(" ", "-")


class Helper:
    def fallback(self, ctx):
        return slugify(str(ctx))
