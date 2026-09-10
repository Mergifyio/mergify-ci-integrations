#!/usr/bin/env python3
"""Assert the contents of the built distributions, before they become a draft
release and therefore before they can be published.

The Python counterpart of check-ts-packages.mjs, and it exists for the same
reason: a build that succeeds proves nothing about what it produced. maturin
emits a well-formed wheel whether or not the compiled extension ended up inside
it, whether or not the licence came along, and whether or not the pytest11
entry point still names something importable -- and a wheel missing that entry
point installs perfectly and then does nothing at all, silently, for every user.

Runs against the artifacts themselves rather than the source tree, so a
packaging defect has somewhere to be caught other than after an immutable tag.

Usage: check-pytest-packages.py <dist-dir> <version>
"""

from __future__ import annotations

import hashlib
import pathlib
import sys
import tarfile
import zipfile

# One wheel per matrix leg in build-pytest-mergify-wheels.yml. Pinned as a set
# rather than a count: a leg that silently stops producing a wheel is exactly
# the failure that shipped ts-v0.3.6 with no Windows binary, and "six wheels
# instead of seven" is not something anyone notices in a release log. Adding a
# target means adding it here.
EXPECTED_PLATFORMS = {
    "macosx_10_12_x86_64",
    "macosx_11_0_arm64",
    "manylinux_2_17_aarch64",
    "manylinux_2_17_x86_64",
    "musllinux_1_2_aarch64",
    "musllinux_1_2_x86_64",
    "win_amd64",
}

# The extension is `pytest_mergify._mergify_ci`, built abi3 so one wheel per
# platform covers every CPython 3.8+.
EXTENSION_STEMS = ("pytest_mergify/_mergify_ci",)
ABI_TAG = "cp38-abi3"

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

problems: list[str] = []


def fail(where: str, msg: str) -> None:
    problems.append(f"{where}: {msg}")


def license_digest_of(data: bytes) -> str:
    """Digest of the licence text with line endings normalised.

    Each matrix leg copies the root LICENSE on its own runner, and the Windows
    one checks out with autocrlf, so its copy is byte-different (10319 vs 10143)
    while being the same licence. Comparing raw bytes would fail every release
    on that one wheel; what this needs to catch is a stale or truncated copy,
    which normalising CRLF does not hide.
    """
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def parse_headers(text: str) -> dict[str, list[str]]:
    """RFC822-ish METADATA/PKG-INFO headers, stopping at the body."""
    headers: dict[str, list[str]] = {}
    for line in text.splitlines():
        if not line.strip():
            break
        if line.startswith((" ", "\t")):
            continue
        key, _, value = line.partition(":")
        headers.setdefault(key.strip(), []).append(value.strip())
    return headers


def check_wheel(path: pathlib.Path, version: str, license_digest: str) -> str | None:
    """Returns the wheel's platform tag, or None when it could not be read."""
    name = path.name
    parts = name[: -len(".whl")].split("-")
    if len(parts) < 5:
        fail(name, "filename is not a valid wheel name")
        return None
    _, file_version, python_tag, abi_tag, platform_tag = parts[0], parts[1], *parts[2:5]

    if file_version != version:
        fail(name, f"filename says {file_version}, expected {version}")
    if f"{python_tag}-{abi_tag}" != ABI_TAG:
        fail(name, f"tagged {python_tag}-{abi_tag}, expected {ABI_TAG}")

    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        dist_info = f"pytest_mergify-{file_version}.dist-info"

        # --- the compiled extension actually made it in --------------------
        # A pure-Python wheel here means the Rust build silently produced
        # nothing; it installs fine and fails at import.
        if not any(
            n.startswith(EXTENSION_STEMS) and n.endswith((".so", ".pyd", ".dylib"))
            for n in names
        ):
            fail(name, "no compiled extension module packed")

        # --- the pytest plugin is still registered -------------------------
        # Without this the plugin is never loaded and the run reports nothing,
        # with no error anywhere. Nothing else in CI would notice.
        try:
            entry_points = zf.read(f"{dist_info}/entry_points.txt").decode()
            if "[pytest11]" not in entry_points:
                fail(name, "entry_points.txt declares no [pytest11] section")
            elif "pytest_mergify" not in entry_points.split("[pytest11]", 1)[1]:
                fail(name, "the [pytest11] entry point does not name pytest_mergify")
        except KeyError:
            fail(name, "no entry_points.txt")

        # --- licence -------------------------------------------------------
        licence = f"{dist_info}/licenses/LICENSE"
        if licence not in names:
            fail(name, "no licenses/LICENSE")
        elif license_digest_of(zf.read(licence)) != license_digest:
            fail(name, "LICENSE differs from the repository root LICENSE")

        # --- metadata ------------------------------------------------------
        try:
            meta = parse_headers(zf.read(f"{dist_info}/METADATA").decode())
        except KeyError:
            fail(name, "no METADATA")
            return platform_tag
        if meta.get("Version", [None])[0] != version:
            fail(name, f"METADATA Version is {meta.get('Version')}, expected {version}")
        if meta.get("License-Expression", [None])[0] != "Apache-2.0":
            fail(name, f"License-Expression is {meta.get('License-Expression')}")
        if "LICENSE" not in meta.get("License-File", []):
            fail(name, "METADATA does not declare License-File: LICENSE")

        # The long description is the package's PyPI page. `twine check` only
        # warns when it is missing and cannot fail at all on a markdown one --
        # its single hard assertion is an RST syntax check, and this project's
        # readme is markdown -- so the useful half of it lives here instead,
        # where an empty page fails the release.
        if not meta.get("Description-Content-Type"):
            fail(name, "METADATA declares no Description-Content-Type")
        body = zf.read(f"{dist_info}/METADATA").decode().partition("\n\n")[2]
        if len(body.strip()) < 200:
            fail(name, f"METADATA carries no meaningful long description ({len(body.strip())} chars)")

        # --- nothing that should never ship --------------------------------
        for n in names:
            if "__pycache__/" in n or n.endswith((".pyc", ".pem")) or n.endswith(".env"):
                fail(name, f"packed {n}")

    # A wheel may carry a compressed tag set, dot-separated -- manylinux wheels
    # name both the PEP 600 and the legacy PEP 599 tag. Match on any component.
    for component in platform_tag.split("."):
        if component in EXPECTED_PLATFORMS:
            return component
    return platform_tag


def check_sdist(path: pathlib.Path, version: str) -> None:
    name = path.name
    with tarfile.open(path) as tf:
        names = tf.getnames()
        root = f"pytest_mergify-{version}"

        # PyPI resolves License-File from the sdist root and rejects the upload
        # when it does not resolve -- which is what sank 2026.8.5.1.
        if f"{root}/LICENSE" not in names:
            fail(name, "no LICENSE at the sdist root")

        # maturin vendors the workspace so the extension can build from the
        # sdist; without the crates it is unbuildable and the upload is a lie.
        if not any(n.startswith(f"{root}/crates/") for n in names):
            fail(name, "no vendored crates/ -- the sdist cannot build the extension")

        try:
            meta = parse_headers(tf.extractfile(f"{root}/PKG-INFO").read().decode())
            if meta.get("Version", [None])[0] != version:
                fail(name, f"PKG-INFO Version is {meta.get('Version')}, expected {version}")
        except (KeyError, AttributeError):
            fail(name, "no readable PKG-INFO")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check-pytest-packages.py <dist-dir> <version>", file=sys.stderr)
        return 2
    dist = pathlib.Path(sys.argv[1])
    version = sys.argv[2]

    license_digest = license_digest_of((REPO_ROOT / "LICENSE").read_bytes())

    wheels = sorted(dist.glob("*.whl"))
    sdists = sorted(dist.glob("*.tar.gz"))
    if not wheels:
        print(f"::error::no wheels in {dist}", file=sys.stderr)
        return 1

    seen = {p for p in (check_wheel(w, version, license_digest) for w in wheels) if p}

    missing = EXPECTED_PLATFORMS - seen
    extra = seen - EXPECTED_PLATFORMS
    if missing:
        problems.append(f"no wheel for {', '.join(sorted(missing))}")
    if extra:
        problems.append(f"unexpected wheel platform {', '.join(sorted(extra))}")

    if len(sdists) != 1:
        problems.append(f"expected exactly one sdist, found {len(sdists)}")
    else:
        check_sdist(sdists[0], version)

    if problems:
        for p in problems:
            print(f"::error::{p}", file=sys.stderr)
        print(
            f"\n{len(problems)} problem(s) across "
            f"{len(wheels)} wheel(s) and {len(sdists)} sdist(s)",
            file=sys.stderr,
        )
        return 1

    print(f"ok: {len(wheels)} wheels + {len(sdists)} sdist, all at {version}")
    for platform in sorted(seen):
        print(f"  {platform}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
