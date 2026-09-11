import dataclasses
import datetime
import json
import os
import typing


@dataclasses.dataclass
class StructuredLog:
    message: str
    timestamp: datetime.datetime
    attributes: typing.Dict[str, typing.Any]

    @classmethod
    def make(cls, message: str, **kwargs: typing.Any) -> "StructuredLog":
        return cls(
            message=message,
            timestamp=datetime.datetime.now(datetime.timezone.utc),
            attributes=kwargs,
        )

    def to_json(self) -> str:
        return json.dumps(
            {
                "timestamp": self.timestamp.isoformat(),
                "message": self.message,
                **self.attributes,
            }
        )


def is_env_true(env: str) -> bool:
    """
    Whether the user turned on a flag this plugin documents as a boolean.

    Anything unrecognised is off, so that a misspelt `true` cannot enable a
    feature the user never asked for.
    """
    try:
        return strtobool(os.environ.get(env, "").strip())
    except ValueError:
        return False


def is_env_enabled(env: str) -> bool:
    """
    Whether an environment variable marks a provider as the one in use.

    Providers set these to a boolean, to their own name, or to a URL, so
    anything non-empty that is not a boolean counts as on.
    """
    value = os.environ.get(env, "").strip()

    try:
        return strtobool(value)
    except ValueError:
        return bool(value)


def is_in_ci() -> bool:
    return is_env_enabled("CI") or is_env_true("PYTEST_MERGIFY_ENABLE")


class InvalidRepositoryFullNameError(Exception):
    pass


def split_full_repo_name(
    full_repo_name: str,
) -> typing.Tuple[str, str]:
    split_name = full_repo_name.split("/")
    if len(split_name) == 2:
        return split_name[0], split_name[1]

    raise InvalidRepositoryFullNameError(f"Invalid repository name: {full_repo_name}")


def strtobool(string: str) -> bool:
    if string.lower() in {"y", "yes", "t", "true", "on", "1"}:
        return True

    if string.lower() in {"n", "no", "f", "false", "off", "0"}:
        return False

    raise ValueError(f"Could not convert '{string}' to boolean")
