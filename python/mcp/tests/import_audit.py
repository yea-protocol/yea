"""The import graph of the code that reads a form answer, and an allowlist audit over it (AGENTS.md
rule 3, #337), as ts/test/imports.ts does for TypeScript.

From ``yea_mcp``'s answer path, it follows every import into ``yea_mcp`` and ``yea``, resolving each
imported name to the module that defines it (so ``from yea import Plan`` follows ``yea.service.plan``,
not the whole package). Every other module imported on the way must be listed; anything else fails
with the file and the module. Loading code at run time, and the ``os`` calls that start a process,
are always refused."""

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


def refused(tree: ast.AST) -> list[str]:
    """The constructs in a parsed file that load code or start a process."""
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in REFUSED_CALLS:
            out.append(f"{node.func.id}()")
        elif isinstance(node, ast.Name) and node.id in REFUSED_NAMES:
            out.append(node.id)
        elif isinstance(node, ast.Attribute) and node.attr in REFUSED_NAMES:
            out.append(node.attr)
        elif (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "os"
              and (node.attr in REFUSED_OS or node.attr.startswith(("exec", "spawn")))):
            out.append(f"os.{node.attr}")
        elif isinstance(node, ast.ImportFrom) and node.module == "os":
            out += [f"os.{a.name}" for a in node.names if a.name in REFUSED_OS or a.name.startswith(("exec", "spawn"))]
    return out


def reachable(starts: list[Path]) -> list[Path]:
    """Every internal source file the answer path reaches from ``starts``."""
    seen: set[Path] = set()
    queue = list(starts)
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        for module, internal in _imports(path, ast.parse(path.read_text())):
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
        name, tree = str(path.relative_to(REPO)), ast.parse(path.read_text())
        for module, internal in _imports(path, tree):
            files = allowed.get(module.split(".")[0], set())
            if not internal and files is not None and name not in files:
                out.append(f"{name}: {module}")
        out += [f"{name}: {r}" for r in refused(tree)]
    return out
