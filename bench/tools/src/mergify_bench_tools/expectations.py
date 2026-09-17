"""The bench's expectations file, loaded into typed records."""

import dataclasses
import pathlib
import typing

import yaml

DEFAULT_PATH = pathlib.Path(__file__).resolve().parents[3] / "expectations.yaml"


@dataclasses.dataclass(frozen=True)
class ExpectedTest:
    name: str
    test_filepath: str
    test_function_name: str
    last_conclusion: str


@dataclasses.dataclass(frozen=True)
class ClientExpectations:
    client: str
    job_name: str
    exit_code: int
    required_output: tuple[str, ...]
    forbidden_output: tuple[str, ...]
    recorded: dict[str, str]
    tests: tuple[ExpectedTest, ...]


def load(client: str, path: pathlib.Path = DEFAULT_PATH) -> ClientExpectations:
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    clients: dict[str, typing.Any] = document["clients"]
    if client not in clients:
        known = ", ".join(sorted(clients))
        raise SystemExit(f"no expectations for client {client!r} (known: {known})")
    raw = clients[client]
    return ClientExpectations(
        client=client,
        job_name=raw["job_name"],
        exit_code=raw["exit_code"],
        required_output=tuple(raw["output"]["required"]),
        forbidden_output=tuple(raw["output"]["forbidden"]),
        recorded=dict(raw["recorded"]),
        tests=tuple(ExpectedTest(**test) for test in raw["tests"]),
    )
