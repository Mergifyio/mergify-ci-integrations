#!/usr/bin/env python3
"""Install the built wheel the way a user would, on this runner's platform, and
prove the result actually works.

The Python counterpart of check-ts-install.mjs. Installing and importing is the
easy half; the half that matters is the last check, which asserts pytest really
registers the plugin through its `pytest11` entry point. A wheel whose entry
point is missing or misnamed installs without complaint and then does nothing at
all -- no plugin, no spans, no error -- which is the same shape of failure as the
runner path that shipped broken in the TS reporter for five releases.

Deliberately installed into a throwaway venv from the wheel alone, with no
access to the source tree, so nothing can be satisfied by a stray import path.

Usage: check-pytest-install.py <dist-dir> <version>
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
import sysconfig
import tempfile

problems: list[str] = []


def wheel_for_this_platform(dist: pathlib.Path, version: str) -> pathlib.Path:
    """The one wheel this runner can execute.

    Picked by asking pip rather than by pattern-matching tags ourselves: pip is
    the thing that has to agree, and a wheel it declines to install is a failure
    worth surfacing as one.
    """
    wheels = sorted(dist.glob(f"pytest_mergify-{version}-*.whl"))
    if not wheels:
        raise SystemExit(f"::error::no wheels for {version} in {dist}")
    return wheels[0]  # pip selects; see install() below


def run(argv: list[str], **kw: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True, **kw)  # noqa: S603


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check-pytest-install.py <dist-dir> <version>", file=sys.stderr)
        return 2
    dist = pathlib.Path(sys.argv[1]).resolve()
    version = sys.argv[2]

    print(f"platform: {sysconfig.get_platform()}, python {sys.version.split()[0]}")

    with tempfile.TemporaryDirectory() as tmp:
        work = pathlib.Path(tmp)
        venv = work / "venv"

        created = run([sys.executable, "-m", "venv", str(venv)])
        if created.returncode != 0:
            print(f"::error::could not create a venv: {created.stderr}", file=sys.stderr)
            return 1
        python = venv / ("Scripts" if sys.platform == "win32" else "bin") / (
            "python.exe" if sys.platform == "win32" else "python"
        )

        # Two steps on purpose. The first installs the built wheel and nothing
        # else: --find-links with --no-index lets pip pick the wheel whose tags
        # match this interpreter -- which is itself part of the check, since a
        # mistagged wheel is one pip declines -- while making it impossible to
        # satisfy the requirement from the published release instead. --no-deps
        # keeps that restriction from also having to cover pytest.
        install = run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--no-index",
                "--no-deps",
                "--find-links",
                str(dist),
                f"pytest-mergify=={version}",
            ]
        )
        if install.returncode != 0:
            print(
                f"::error::pip would not install the wheel:\n{install.stdout}\n{install.stderr}",
                file=sys.stderr,
            )
            return 1

        # Then its runtime dependencies, from the index like any user's install.
        deps = run([str(python), "-m", "pip", "install", "pytest", "pytest-timeout"])
        if deps.returncode != 0:
            print(f"::error::could not install dependencies:\n{deps.stderr}", file=sys.stderr)
            return 1

        installed = run(
            [str(python), "-c", "import pytest_mergify, sys; print(pytest_mergify.__file__)"]
        )
        if installed.returncode != 0:
            problems.append(f"import pytest_mergify failed: {installed.stderr.strip()}")
        else:
            print(f"  imported from {installed.stdout.strip()}")

        # --- the compiled extension loads and the Rust core answers ---------
        native = run(
            [
                str(python),
                "-c",
                "from pytest_mergify import _mergify_ci as m;"
                "a = m.detect_attributes();"
                "assert isinstance(a, dict), type(a);"
                "print('  detect_attributes() ok')",
            ]
        )
        if native.returncode != 0:
            problems.append(f"the compiled extension failed: {native.stderr.strip()}")
        else:
            print(native.stdout.strip())

        # --- pytest actually registers the plugin ---------------------------
        # The entry point is what makes this a plugin at all. Asking pytest's own
        # plugin manager is the only check that proves it: importing the module
        # by hand would pass even with the entry point gone.
        # A real collection, not `--version`: the latter short-circuits before
        # pytest_configure runs, so the plugin manager is never consulted and
        # the probe passes on a package with no entry point at all.
        (work / "tests").mkdir()
        (work / "tests" / "test_probe.py").write_text("def test_probe():\n    assert True\n")
        probe = work / "probe.py"
        probe.write_text(
            "import pytest\n"
            "\n"
            "class Probe:\n"
            "    names = []\n"
            "    def pytest_configure(self, config):\n"
            "        Probe.names = [n for n, _ in config.pluginmanager.list_name_plugin() if n]\n"
            "\n"
            "rc = pytest.main(['--collect-only', '-q', 'tests'], plugins=[Probe()])\n"
            "# `pytest_mergify` is the entry point pytest loads; `PytestMergify` is\n"
            "# the plugin that module registers on load. Requiring both means a\n"
            "# module that imports but never registers itself fails too.\n"
            "missing = [n for n in ('pytest_mergify', 'PytestMergify') if n not in Probe.names]\n"
            "if rc != 0:\n"
            "    print('pytest exited', rc)\n"
            "if missing:\n"
            "    print('not registered:', ', '.join(missing))\n"
            "raise SystemExit(1 if (rc != 0 or missing) else 0)\n"
        )
        registered = run([str(python), str(probe)], cwd=str(work))
        if registered.returncode != 0:
            problems.append(
                "pytest did not register the plugin -- the pytest11 entry point is not "
                f"working: {registered.stdout.strip()}"
            )
        else:
            print("  pytest registers the plugin via its pytest11 entry point")

    if problems:
        for p in problems:
            print(f"::error::{p}", file=sys.stderr)
        return 1

    print(f"ok: the wheel installs and works on {sysconfig.get_platform()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
