"""The import graph of the code that reads a form answer, and an allowlist audit over it (AGENTS.md
rule 3, #337), as ts/test/imports.ts does for TypeScript.

From ``yea_mcp``'s answer path, it follows every import into ``yea_mcp`` and ``yea``, resolving each
imported name to the module that defines it (so ``from yea import Plan`` follows ``yea.service.plan``,
not the whole package). Every other module imported on the way must be listed; anything else fails
with the file and the module. Loading code at run time, the ``os`` calls that start a process
(through any alias), ``sys.modules``, and a file that doesn't parse are always refused."""

from __future__ import annotations

import ast
import os
from collections.abc import Iterator
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ROOTS = {"yea_mcp": REPO / "python/mcp/src", "yea": REPO / "python/src"}

# The calls and ``os`` functions that load code or start a process: refused on the path, always.
REFUSED_CALLS = {"__import__", "exec", "eval", "compile"}
REFUSED_NAMES = {"__import__", "importlib", "import_module"}
REFUSED_OS = {"system", "popen", "fork", "forkpty", "startfile", "posix_spawn", "posix_spawnp"}


def _exists(path: Path) -> bool:
    """Whether ``path`` exists with exactly this name: macOS's file system ignores case."""
    return path.parent.is_dir() and path.name in os.listdir(path.parent)


def file_of(module: str) -> Path | None:
    """The source file of an internal module, or None for one outside ``yea_mcp`` and ``yea``."""
    root = ROOTS.get(module.split(".")[0])
    if root is None:
        return None
    base = root.joinpath(*module.split("."))
    for candidate in (base.with_suffix(".py"), base / "__init__.py"):
        if _exists(candidate):
            return candidate
    return None


def _module_of(path: Path) -> tuple[str, bool]:
    """A source file's module name, and whether it's a package's ``__init__``."""
    for root in ROOTS.values():
        if path.is_relative_to(root):
            parts = list(path.relative_to(root).with_suffix("").parts)
            if parts[-1] == "__init__":
                return ".".join(parts[:-1]), True
            return ".".join(parts), False
    raise ValueError(f"{path} is outside yea_mcp and yea")


def _absolute(path: Path, node: ast.ImportFrom) -> str:
    """The module an ``ImportFrom`` names, with a relative one resolved against ``path``."""
    if node.level == 0:
        return node.module or ""
    module, is_package = _module_of(path)
    base = module.split(".") if is_package else module.split(".")[:-1]
    base = base[:len(base) - (node.level - 1)]
    return ".".join(base + ([node.module] if node.module else []))


def _defining(module: str, name: str) -> str:
    """The module that defines ``name``: a submodule, or the source a package's ``__init__`` re-exports it from."""
    if file_of(f"{module}.{name}"):
        return f"{module}.{name}"
    init = file_of(module)
    if init is None or init.name != "__init__.py":
        return module
    for node in ast.parse(init.read_text()).body:
        if isinstance(node, ast.ImportFrom) and any((a.asname or a.name) == name for a in node.names):
            source = _absolute(init, node)
            return _defining(source, name) if file_of(source) else module
    return module


def _imports(path: Path, tree: ast.AST) -> Iterator[tuple[str, bool]]:
    """Each module ``path`` imports, anywhere in it, and whether it's internal (``yea_mcp`` or ``yea``)."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name, file_of(alias.name) is not None
        elif isinstance(node, ast.ImportFrom):
            module = _absolute(path, node)
            if file_of(module) is None:
                yield module, False
            else:
                for alias in node.names:
                    yield _defining(module, alias.name), True


def _starts_a_process(name: str) -> bool:
    return name in REFUSED_OS or name.startswith(("exec", "spawn"))


def _aliases(tree: ast.AST, module: str) -> set[str]:
    """The names a file binds to ``module`` itself: ``import os``, ``import os as o``."""
    return {a.asname or a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names
            if a.name == module}


def _on(node: ast.AST, names: set[str]) -> bool:
    """Whether ``node`` is one of ``names``: a module's alias."""
    return isinstance(node, ast.Name) and node.id in names


def _refused_node(node: ast.AST, os_names: set[str], sys_names: set[str]) -> str | None:
    """The refused construct ``node`` is, or None."""
    on = _on
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        if node.func.id in REFUSED_CALLS:
            return f"{node.func.id}()"
        if node.func.id == "getattr" and len(node.args) > 1 and on(node.args[0], os_names | sys_names):
            name = node.args[1]
            constant = isinstance(name, ast.Constant) and isinstance(name.value, str)
            # A flag looked up by name (``getattr(os, "O_NOFOLLOW", 0)``) is fine; anything else isn't.
            if not constant or _starts_a_process(name.value) or name.value in ("modules", "__dict__"):
                return f"getattr({node.args[0].id}, …)"
    if isinstance(node, ast.Name) and node.id in REFUSED_NAMES:
        return node.id
    if isinstance(node, ast.Attribute):
        if node.attr in REFUSED_NAMES:
            return node.attr
        if on(node.value, os_names) and (_starts_a_process(node.attr) or node.attr == "__dict__"):
            return f"os.{node.attr}"
        if on(node.value, sys_names) and node.attr == "modules":
            return "sys.modules"
    if isinstance(node, ast.ImportFrom) and node.module in ("os", "sys"):
        names = [a.name for a in node.names if _starts_a_process(a.name) or a.name == "modules"]
        return ", ".join(f"{node.module}.{n}" for n in names) or None
    return None


def refused(tree: ast.AST) -> list[str]:
    """The constructs in a parsed file that load code or start a process, through any alias of
    ``os`` or ``sys``: ``import os as o; o.system(…)``, ``getattr(os, …)``, ``sys.modules[…]``."""
    os_names, sys_names = _aliases(tree, "os"), _aliases(tree, "sys")
    found = (_refused_node(n, os_names, sys_names) for n in ast.walk(tree))
    return [f for f in found if f is not None]


def _parse(path: Path) -> ast.AST | str:
    """A file's syntax tree, or why it doesn't parse: then the audit fails it."""
    try:
        return ast.parse(path.read_text())
    except (SyntaxError, ValueError, UnicodeDecodeError) as e:
        return f"does not parse: {e}"


def reachable(starts: list[Path]) -> list[Path]:
    """Every internal source file the answer path reaches from ``starts``."""
    seen: set[Path] = set()
    queue = list(starts)
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        tree = _parse(path)
        if isinstance(tree, str):
            continue
        for module, internal in _imports(path, tree):
            target = file_of(module) if internal else None
            if target is not None:
                queue.append(target)
    return sorted(seen)


def import_audit(starts: list[Path], allowed: dict[str, set[str] | None]) -> list[str]:
    """Each module imported on the path that isn't listed, or is listed for other files only, and
    each refused construct, as ``file: module``. ``allowed`` maps a top-level module to the files
    (relative to the repo) that may import it, or to None for any file. Empty means as reviewed."""
    out = []
    for path in reachable(starts):
        name, tree = str(path.relative_to(REPO)), _parse(path)
        if isinstance(tree, str):
            out.append(f"{name}: {tree}")
            continue
        for module, internal in _imports(path, tree):
            files = allowed.get(module.split(".")[0], set())
            if not internal and files is not None and name not in files:
                out.append(f"{name}: {module}")
        out += [f"{name}: {r}" for r in refused(tree)]
    return out
