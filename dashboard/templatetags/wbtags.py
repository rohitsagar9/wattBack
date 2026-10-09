from django import template

register = template.Library()


@register.filter
def split(value, sep=";"):
    """Split a flag string like 'partial;zero' into a list."""
    if not value:
        return []
    return [p.strip() for p in str(value).replace(",", sep).split(sep) if p.strip()]
