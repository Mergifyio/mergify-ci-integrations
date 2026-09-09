import dataclasses
import textwrap
import typing

import _pytest.config
import _pytest.nodes
import pytest


# What a refusal says when the server sent no wording of its own. The copy
# belongs to the server -- it can be corrected there without publishing a
# client, and it alone knows which job it is talking about -- so this is a
# fallback, not the message.
#
# Written for someone who has jobs and runs, not for someone who knows how
# Mergify stores them: "test session", "previous attempt" and "the run this one
# continues" are our vocabulary, and a reader meeting them in a red build
# learns nothing. So it opens with what happened to THEM, then why, then the
# fix with its documentation, then the way out when the fix does not apply.
#
# It still asserts no cause. A build matrix is the likely producer of several
# runs under one name, not the only one -- a job rerun on the same revision
# leaves the same signature, and renaming per matrix leg would not fix it.
# Hence the condition on the remedy, and the last line.
#
# It names no job, unlike the server's message, which formats one in: the
# plugin would have to carry the job name on every answer to enrich a string
# that renders only if the marshalling loses `message` -- a field on every
# answer to improve one that is not supposed to appear.
FALLBACK_REFUSAL_MESSAGE = (
    "Mergify Test Selection stopped this run.\n"
    "\n"
    "Several runs of this job report to Mergify under the same name, and they"
    " run the same tests — so Mergify cannot tell which one this run repeats,"
    " and it will not guess which tests to skip.\n"
    "\n"
    "If this job runs more than once (a build matrix, for example), give each"
    " run its own name with MERGIFY_TEST_JOB_NAME:\n"
    "https://docs.mergify.com/ci-insights/test-frameworks/pytest/\n"
    "\n"
    "If this job only runs once, this is unexpected — please contact Mergify"
    " support."
)


# Why a run did not do what Mergify answered. Closed on purpose, and named
# after the shape of the answer rather than after what the run did with it:
# what it did is always the same, run everything.
#
# `not applied` and not `degraded`, which this repository already spends on a
# wider class -- a run that never asked, one with no subscription, one whose
# fetch errored all "degrade to a full run" too, and none of them carries a
# value here. Whoever counts these is counting answers Mergify gave and this
# run refused, not runs that ended up executing everything.
#
# THE COUNTING RULE, stated here once and referred to from everywhere else:
# `unrecognised_selection` is a normal condition and must be excluded, or the
# count moves on every engine release. The other three are unreachable against
# a correct engine -- under the collection fingerprint (MRGFY-8995) predecessor
# and rerun collected the same set, so every served id exists in this run --
# which is what makes a non-zero count of them a defect report rather than a
# statistic. A malformed `selection` also lands in `unrecognised_selection`,
# and is told apart from a genuinely newer answer by `test.selection.answer`,
# which carries the raw value: a value outside the engine's own vocabulary was
# emitted by the engine, not predated by the client.
NotAppliedReason = typing.Literal[
    # `subset` with no test in it. An engine that means "run everything" says
    # `full`; a subset naming nothing is a defect on our side, not an answer.
    "subset_served_without_tests",
    # A `selection` value this client predates -- the mechanism by which the
    # engine grows new answers without breaking the clients already published.
    "unrecognised_selection",
    # None of the served ids is in this collection. The two runs share no
    # vocabulary at all.
    "subset_matched_no_collected_test",
    # Some are, some are not. Running the intersection would be a reduced run
    # over an arbitrary part of what was asked for, green on tests nobody
    # chose -- and, unlike the value above, it would still look like an
    # ordinary reduction.
    "subset_partly_absent_from_collection",
]


# One sentence per reason the full suite was served, for the terminal block.
# Written for the developer reading their job log, who wants to know what
# reduced (or did not reduce) their run and whether it was deliberate -- so
# each names the fact and its consequence, and none of them is the identifier.
# Twelve engine reasons collapse into nine sentences: two reasons that leave
# the reader the same thing to do share one. Only the rows that leave them
# something to do carry a second sentence. Wording validated by Alexandre on
# 2026-09-11 (MRGFY-8978); a change here is a product decision.
# No "please report it": these shapes are a defect on our side that we already
# see in our own data (the plugin reports its reason on the session), and
# asking the customer to tell us hands them our work and worries them for
# nothing. Alexandre, 2026-09-11. The one mention of support in the section is
# the run id line, which is information, not an instruction.
_NOT_APPLIED_SENTENCE = (
    "Mergify's answer didn't match the tests this run collected, so the full suite ran."
)

_FULL_RUN_SENTENCES: typing.Dict[str, str] = {
    "no_predecessor": "First attempt of this batch, so the full suite ran.",
    "not_a_merge_queue_run": (
        "This job isn't part of a merge queue run, so the full suite ran."
    ),
    "stale_run": (
        "The batch branch was updated while this job was running, so the full"
        " suite ran."
    ),
    "no_matching_test_session": (
        "The previous attempt didn't run this exact set of tests, so the full"
        " suite ran."
    ),
    "matched_test_session_ran_no_test": (
        "The previous attempt executed no tests, so the full suite ran."
    ),
    "predecessor_unknown": (
        "Mergify couldn't tell which previous run to start from, so the full suite ran."
    ),
    "indeterminate_test_session": (
        "Mergify couldn't tell which previous run to start from, so the full suite ran."
    ),
    "matched_test_session_partially_processed": (
        "Mergify didn't have the complete results of the previous attempt, so"
        " the full suite ran."
    ),
    "matched_test_session_dropped_cases": (
        "Mergify didn't have the complete results of the previous attempt, so"
        " the full suite ran."
    ),
    "matched_test_session_declaration_unreadable": (
        "Mergify didn't have the complete results of the previous attempt, so"
        " the full suite ran."
    ),
    "no_collection_fingerprint": (
        "This version of pytest-mergify doesn't report what it collected, so"
        " the full suite ran. Upgrade it to let Mergify reduce reruns."
    ),
    "feature_disabled": (
        "Test selection isn't enabled for this organization yet, so the full suite ran."
    ),
    # This client's own reasons, never the engine's. A dormant answer -- no
    # subscription, or no such endpoint -- is a normal condition.
    "not_requested": (
        "Test selection isn't available for this repository, so the full suite ran."
    ),
    # An answer this client could not apply. Two remedies, told apart on
    # purpose: a `selection` value this plugin predates is the normal way the
    # engine grows new answers, and is the user's to fix by upgrading; every
    # other shape -- a subset naming no test, or naming tests this run did not
    # collect, in whole or in part -- cannot come from a correct engine under
    # the collection fingerprint, so it is ours to notice, and the three share
    # one sentence because they leave the reader nothing to do.
    "unrecognised_selection": (
        "Mergify answered in a way this version of pytest-mergify doesn't"
        " understand, so the full suite ran. Upgrade it to let Mergify reduce"
        " reruns."
    ),
    "subset_served_without_tests": _NOT_APPLIED_SENTENCE,
    "subset_matched_no_collected_test": _NOT_APPLIED_SENTENCE,
    "subset_partly_absent_from_collection": _NOT_APPLIED_SENTENCE,
}

# A newer engine may serve a reason this client predates. The block must then
# still read as a full run, and must never show the raw identifier.
_UNKNOWN_REASON_SENTENCE = "Mergify served the full suite."

# The block's title, the same `<emoji> <Mechanism>` shape as its neighbours
# in pytest's "Mergify CI" section (🛡️ Quarantine, 🐛 Flaky detection,
# 🔁 Test retry).
_HEADER = "✂️ Test selection"

# How many re-executed tests the subset block lists by name before it counts
# the rest. Enough to recognise the failures, not enough to bury the sentence
# above them under a screen of node ids.
_LISTED_TESTS_MAX = 10

# The paragraphs wrap at this width, which is what the wording was validated
# at: a block that fits an 80-column log viewer without the viewer's own,
# uglier wrapping.
_WRAP_WIDTH = 80


def _tests(count: int) -> str:
    return "1 test" if count == 1 else f"{count} tests"


@dataclasses.dataclass
class TestSelection:
    """Whether this run should execute only a subset of tests.

    A merge-queue rerun (a `max_checks_retries` attempt or a bisection step)
    only needs to replay the tests that failed on the previous attempt.
    Mergify resolves that server-side from the run's own identity (queue
    branch + head SHA + job) AND from the fingerprint of what this run
    collected -- a subset is only safe to serve to a run that collects the same
    tests the previous attempt did, so the request cannot be made before the
    collection is known. The bundled binding
    (`CiApiClient.fetch_test_selection`) fetches the answer and it is injected
    here.

    Four answers are understood:

    * `full` -- run everything.
    * `subset` -- run only `tests`.
    * `empty` -- run nothing: the predecessor's attempt of this job already ran
      these tests and they passed. The run exits green having executed none of
      them, and still uploads its session.
    * `refused` -- Mergify holds several candidate sessions for this job and
      will not guess between them. The run FAILS, showing the server's own
      explanation (`message`), or `FALLBACK_REFUSAL_MESSAGE` if it sent none.

    Every error, timeout, and every answer outside that list degrades to
    running the full suite — the feature can remove work, never correctness,
    and a client is routinely older than the server it talks to.

    When an answer cannot be honoured the run executes everything and says so
    in `not_applied_reason`, never by rewriting `selection` or `reason`: those
    two carry Mergify's word, and the only moment their value would prove
    Mergify said something wrong is the moment rewriting them would erase it.
    """

    # The vocabulary the SERVER is meant to use, not a guarantee about what
    # this field holds: an answer from a newer engine is kept verbatim rather
    # than rewritten, so at runtime this is any string, and
    # `not_applied_reason == "unrecognised_selection"` is what says so. Do not
    # write an exhaustive match on it -- mypy would accept one, and it would be
    # wrong on exactly the runs this class exists to describe.
    selection: typing.Literal["full", "subset", "empty", "refused"] = "full"
    reason: str = "not_requested"
    tests: typing.List[str] = dataclasses.field(default_factory=list)
    # What the server wants shown to the CI user about this answer, when it has
    # something to say -- today only a refusal does. Shown verbatim: the wording
    # is the server's so it can be improved without publishing a client.
    message: typing.Optional[str] = None
    # The bare error text when the request itself failed -- what support will
    # ask for. The terminal block wraps it in its own sentence about what the
    # failure meant for this run, so it must not already be one.
    init_error_msg: typing.Optional[str] = None
    # Why this run did not do what Mergify answered, in the client's own closed
    # vocabulary -- unlike `reason`, which is the server's and open-ended. Set
    # means the full suite ran whatever `selection` says; `None` means the
    # answer was honoured exactly. See `NotAppliedReason` for the counting rule.
    not_applied_reason: typing.Optional[NotAppliedReason] = dataclasses.field(
        init=False, default=None
    )
    kept_count: typing.Optional[int] = dataclasses.field(init=False, default=None)
    deselected_count: int = dataclasses.field(init=False, default=0)
    # The node ids a subset actually re-executed -- the served names that were
    # collected -- in collection order, for the terminal block to list.
    kept_tests: typing.List[str] = dataclasses.field(init=False, default_factory=list)

    def __post_init__(self) -> None:
        # `empty` and `refused` are answers in themselves and carry no tests,
        # and so does `full`. A subset is only honoured with a non-empty list;
        # a `subset` the server sent empty, and a variant this client predates,
        # both run everything. Acting on a value we cannot reason about is the
        # one outcome that loses coverage silently, on a run that reports green.
        if self.selection == "subset":
            if not self.tests:
                self.not_applied_reason = "subset_served_without_tests"
            return

        if self.selection not in ("full", "empty", "refused"):
            self.not_applied_reason = "unrecognised_selection"

        self.tests = []

    def filter_items(
        self,
        config: _pytest.config.Config,
        items: typing.List[_pytest.nodes.Item],
    ) -> None:
        """Apply the served answer to the collected items, in place.

        Matching is by exact nodeid — the identifiers Mergify serves are the
        ones this plugin previously uploaded. A subset is honoured all or not
        at all: one served id this collection does not hold declines the whole
        answer and runs everything, rather than reducing to the part that did
        match.

        Raises `pytest.UsageError` on a refusal, which is what fails the run,
        carrying the server's explanation of it.
        """
        if self.not_applied_reason is not None:
            # Declared at construction: there was an answer, and this client
            # could not act on it. Leaving the collection alone is the full
            # suite.
            return

        if self.selection == "refused":
            # Deliberately not the degradation path. Everywhere else, a shape
            # Mergify cannot resolve costs time and nothing else; here it is
            # Mergify saying it holds several candidate predecessors for this
            # job, which means one job name is standing for several runs. That
            # keeps the reporting wrong for every future attempt, so it has to
            # be seen and fixed rather than absorbed into a full run nobody
            # notices.
            raise pytest.UsageError(self.message or FALLBACK_REFUSAL_MESSAGE)

        if self.selection == "empty":
            self._deselect_everything(config, items)
            return

        if self.selection != "subset":
            return

        subset = set(self.tests)
        kept = [item for item in items if item.nodeid in subset]
        matched = {item.nodeid for item in kept}
        if matched != subset:
            # Identities, not counts. `kept` holds collected ITEMS and `subset`
            # holds distinct ids, and the two stop being comparable as soon as
            # a nodeid appears twice -- which `pytest --keep-duplicates` does on
            # purpose. Under a count comparison one duplicate cancels one
            # missing served id, and the run reduces to an arbitrary part of
            # what was asked for while reporting an ordinary reduction: exactly
            # the outcome this branch exists to prevent.
            self.not_applied_reason = (
                "subset_matched_no_collected_test"
                if not matched
                else "subset_partly_absent_from_collection"
            )
            return

        deselected = [item for item in items if item.nodeid not in subset]
        if deselected:
            items[:] = kept
            config.hook.pytest_deselected(items=deselected)

        self.kept_count = len(kept)
        self.deselected_count = len(deselected)
        self.kept_tests = [item.nodeid for item in kept]

    def _deselect_everything(
        self,
        config: _pytest.config.Config,
        items: typing.List[_pytest.nodes.Item],
    ) -> None:
        """Empty the collection through pytest's own deselection path.

        Deselecting rather than stopping the session is what keeps the rest of
        the run intact: the session still finishes, so it still uploads. A
        `pytest.exit` here would be shorter and would make the one job that
        legitimately ran nothing the only one missing from Mergify's reporting.

        A collection that is already empty is left alone, counters included: the
        run is then red for a reason of its own (a `-k` matching nothing), and
        recording an application would have this answer both green that exit
        code and announce a skip over a suite it never emptied.
        """
        if not items:
            return

        self.deselected_count = len(items)
        deselected = list(items)
        items[:] = []
        config.hook.pytest_deselected(items=deselected)

    def report(self) -> str:
        """The block pytest prints in its "Mergify CI" terminal section.

        Written for a developer who opened the job log because it reported 1
        test where the suite has thousands, and who wants to know: what
        reduced my run, was it deliberate, and can I trust this green. So it is
        prose, not a bullet list, and no identifier from the API ever reaches
        it -- `reason` is translated, never shown.

        `empty` and `subset` describe what was skipped and why it was safe;
        `full` is one sentence saying why nothing was reduced; an answer this
        run could not apply is one sentence too, chosen by the run's own
        `not_applied_reason` rather than by Mergify's `reason` -- which
        describes the answer that was NOT applied, and would read as a
        reduction; a refusal points at the engine's own explanation, which
        pytest has already printed as the error that stopped the run; and a
        request that failed says so and keeps the error text, which is what
        support will ask for.
        """
        if self.init_error_msg is not None:
            # The error text is appended verbatim on its own line rather than
            # wrapped into the sentence: it is what support will ask for, and
            # it usually carries a URL that wrapping would split at a hyphen.
            return (
                self._block(
                    "Mergify couldn't be asked whether this run could be reduced,"
                    " so the full suite ran."
                )
                + f"Error: {self.init_error_msg}\n"
            )

        if self.selection == "refused":
            # The engine's explanation already reached the developer: it is the
            # text of the `UsageError` that stopped the run, which pytest prints
            # on stderr. Repeating five paragraphs here would show it twice, so
            # the block only says where to look.
            return self._block(
                "Mergify stopped this run before any test ran; its explanation is"
                " in the error above."
            )

        if self.selection == "empty":
            return self._empty_block()

        if self.selection == "subset" and self.kept_count is not None:
            return self._subset_block()

        # A declined answer keeps Mergify's `reason` verbatim (it is the
        # server's word, never rewritten), so on that path the sentence is
        # keyed by what THIS run did with the answer.
        return self._block(
            _FULL_RUN_SENTENCES.get(
                self.not_applied_reason or self.reason, _UNKNOWN_REASON_SENTENCE
            )
        )

    def _empty_block(self) -> str:
        skipped = self.deselected_count
        if skipped == 0:
            # `-k` left nothing to run and pytest's exit code 5 says so. A
            # paragraph about Mergify skipping "all 0 tests" would send whoever
            # is debugging that red job to look at Mergify instead of at their
            # own filter, so the block is the title alone.
            return f"{_HEADER}\n"
        if skipped == 1:
            passed, them = "its only test passed back then", "it"
        else:
            passed, them = f"all {skipped} tests passed back then", "them"
        return self._block(
            "The code under test hasn't changed since the previous attempt of"
            f" this job, and {passed}. Mergify skipped {them}: the job is green,"
            " and no test was executed."
        )

    def _subset_block(self) -> str:
        assert self.kept_count is not None
        failed = self.kept_count
        skipped = self.deselected_count
        if skipped == 0:
            # Every collected test had failed: nothing was skipped, and a
            # sentence about skipping "the 0 that had already passed" would be
            # a sentence about nothing.
            if failed == 1:
                which, them = "its only test failed", "it"
            else:
                which, them = f"all {failed} of its tests failed", "all of them"
            sentence = (
                "The code under test hasn't changed since the previous attempt"
                f" of this job, where {which}. Mergify re-executed {them}:"
            )
        else:
            those = "that one" if failed == 1 else f"those {failed}"
            sentence = (
                "The code under test hasn't changed since the previous attempt"
                f" of this job, where {failed} of its {_tests(failed + skipped)}"
                f" failed. Mergify re-executed only {those} and skipped the"
                f" {skipped} that had already passed:"
            )

        lines = [f"  {name}" for name in self.kept_tests[:_LISTED_TESTS_MAX]]
        remaining = len(self.kept_tests) - _LISTED_TESTS_MAX
        if remaining > 0:
            lines.append(f"  … and {remaining} more")
        return self._block(sentence) + "\n" + "\n".join(lines) + "\n"

    @staticmethod
    def _block(text: str) -> str:
        return f"{_HEADER}\n\n{textwrap.fill(text, _WRAP_WIDTH)}\n"
