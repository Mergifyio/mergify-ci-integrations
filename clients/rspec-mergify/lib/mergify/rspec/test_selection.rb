# frozen_string_literal: true

require 'set'
require_relative 'utils'

module Mergify
  module RSpec
    # Raised by `TestSelection#resolve` when Mergify refuses to choose a
    # selection for this run, carrying the explanation to show. The caller
    # stops the run with it.
    class TestSelectionRefused < StandardError; end

    # Whether this run should execute only part of what it collected.
    #
    # A merge-queue rerun only needs to replay the examples that failed on the
    # previous attempt of the same job. Mergify decides that server-side from
    # the run's own identity AND from the fingerprint of what the run
    # collected, which is why the request leaves only once RSpec has loaded
    # and filtered its examples. The answer is one of:
    #
    # * `full` -- run everything;
    # * `subset` -- run only `tests`;
    # * `empty` -- run nothing: the previous attempt ran these examples and
    #   they passed, so the run exits green having executed none;
    # * `refused` -- Mergify holds several candidate sessions for this job and
    #   will not guess between them, so the run FAILS with its explanation.
    #
    # Every error, and every answer outside that list, runs the whole suite:
    # the feature can remove work, never correctness. pytest-mergify's
    # `TestSelection`, answer for answer and sentence for sentence.
    #
    # When an answer cannot be honoured the run executes everything and says
    # so in `not_applied_reason`, never by rewriting `selection` or `reason`:
    # those two carry Mergify's word.
    # rubocop:disable-next Metrics/ClassLength
    class TestSelection
      ENABLE_ENV = 'MERGIFY_TEST_SELECTION_ENABLE'

      CLIENT_NAME = 'rspec-mergify'
      DOCS_URL = 'https://docs.mergify.com/ci-insights/test-frameworks/rspec/'

      # What a refusal says when the server sent no wording of its own. The
      # copy belongs to the server; this is a fallback, not the message.
      FALLBACK_REFUSAL_MESSAGE = <<~MESSAGE.chomp
        Mergify Test Selection stopped this run.

        Several runs of this job report to Mergify under the same name, and they run the same tests — so Mergify cannot tell which one this run repeats, and it will not guess which tests to skip.

        If this job runs more than once (a build matrix, for example), give each run its own name with MERGIFY_TEST_JOB_NAME:
        #{DOCS_URL}

        If this job only runs once, this is unexpected — please contact Mergify support.
      MESSAGE

      NOT_APPLIED_SENTENCE =
        "Mergify's answer didn't match the tests this run collected, so the full suite ran."

      # One sentence per reason the full suite ran. pytest-mergify's
      # `_FULL_RUN_SENTENCES` verbatim (validated by Alexandre on 2026-09-11,
      # MRGFY-8978), naming this gem where they name a client. A change here is
      # a product decision.
      FULL_RUN_SENTENCES = {
        'no_predecessor' => 'First attempt of this batch, so the full suite ran.',
        'not_a_merge_queue_run' => "This job isn't part of a merge queue run, so the full suite ran.",
        'stale_run' => 'The batch branch was updated while this job was running, so the full suite ran.',
        'no_matching_test_session' =>
          "The previous attempt didn't run this exact set of tests, so the full suite ran.",
        'matched_test_session_ran_no_test' => 'The previous attempt executed no tests, so the full suite ran.',
        'predecessor_unknown' => "Mergify couldn't tell which previous run to start from, so the full suite ran.",
        'indeterminate_test_session' =>
          "Mergify couldn't tell which previous run to start from, so the full suite ran.",
        'matched_test_session_partially_processed' =>
          "Mergify didn't have the complete results of the previous attempt, so the full suite ran.",
        'matched_test_session_dropped_cases' =>
          "Mergify didn't have the complete results of the previous attempt, so the full suite ran.",
        'matched_test_session_declaration_unreadable' =>
          "Mergify didn't have the complete results of the previous attempt, so the full suite ran.",
        'matched_test_session_incomplete' =>
          'The previous attempt stopped before running all of its tests, so the full suite ran.',
        'matched_test_session_failures_truncated' =>
          'The previous attempt had too many failures for Mergify to list, so the full suite ran.',
        'no_collection_fingerprint' =>
          "This version of #{CLIENT_NAME} doesn't report what it collected, so the full suite ran. " \
          'Upgrade it to let Mergify reduce reruns.',
        'feature_disabled' => "Test selection isn't enabled for this organization yet, so the full suite ran.",
        'not_requested' => "Test selection isn't available for this repository, so the full suite ran.",
        'unrecognised_selection' =>
          "Mergify answered in a way this version of #{CLIENT_NAME} doesn't understand, so the full suite " \
          'ran. Upgrade it to let Mergify reduce reruns.',
        'subset_served_without_tests' => NOT_APPLIED_SENTENCE,
        'subset_matched_no_collected_test' => NOT_APPLIED_SENTENCE,
        'subset_partly_absent_from_collection' => NOT_APPLIED_SENTENCE
      }.freeze

      # A newer engine may serve a reason this gem predates. The block must
      # still read as a full run, and must never show the raw identifier.
      UNKNOWN_REASON_SENTENCE = 'Mergify served the full suite.'

      HEADER = '✂️ Test selection'

      # How many re-executed examples the subset block lists before counting
      # the rest.
      LISTED_TESTS_MAX = 10

      # The width the wording was validated at.
      WRAP_WIDTH = 80

      KNOWN_ANSWERS = %w[full subset empty refused].freeze

      attr_reader :selection, :reason, :tests, :message, :init_error_msg,
                  :not_applied_reason, :kept_count, :deselected_count, :kept_tests

      class << self
        # Whether this job asked for test selection. Opt-in and per job: a job
        # that has not opted in asks nothing, which is what lets Mergify tell
        # a repository that never opted in from one that did (MRGFY-9172).
        # Trimmed, and anything unrecognised is off -- the direction that runs
        # the whole suite.
        def enabled?
          Utils::TRUTHY_STRINGS.include?(ENV.fetch(ENABLE_ENV, '').strip.downcase)
        end

        # What Mergify answered, as the binding hands it over.
        def served(answer)
          new(selection: answer['selection'], reason: answer['reason'], tests: answer['tests'] || [],
              message: answer['message'], served: true)
        end

        # A run Mergify did not answer: the repository has no such feature, or
        # the request failed. Both run everything, and neither was offered
        # anything, so neither is echoed as an answer.
        def unanswered(init_error_msg: nil)
          new(selection: 'full', reason: 'not_requested', tests: [], message: nil,
              served: false, init_error_msg: init_error_msg)
        end
      end

      # rubocop:disable-next Metrics/ParameterLists,Metrics/MethodLength
      def initialize(selection:, reason:, tests:, message:, served:, init_error_msg: nil)
        @selection = selection
        @reason = reason
        @tests = tests
        @message = message
        @served = served
        @init_error_msg = init_error_msg
        @not_applied_reason = nil
        @kept_count = nil
        @deselected_count = 0
        @kept_tests = []

        # A subset is only honoured with a non-empty list, and an answer this
        # gem predates is never acted on: both run everything, and say so.
        if @selection == 'subset'
          @not_applied_reason = 'subset_served_without_tests' if @tests.empty?
        else
          @not_applied_reason = 'unrecognised_selection' unless KNOWN_ANSWERS.include?(@selection)
          @tests = []
        end
      end

      def served?
        @served
      end

      def refused?
        @not_applied_reason.nil? && @selection == 'refused'
      end

      # Decide what the answer leaves of this collection to run: the ids to
      # keep, or nil for all of them. Raises `TestSelectionRefused` on a
      # refusal, carrying the server's explanation.
      #
      # Matching is by exact example id, the identity this gem uploads. A
      # subset is honoured all or not at all: one served id this run did not
      # collect declines the whole answer and runs everything, rather than a
      # reduced run over an arbitrary part of what was asked for.
      # rubocop:disable-next Metrics/MethodLength,Metrics/AbcSize,Metrics/CyclomaticComplexity,Metrics/PerceivedComplexity
      def resolve(ids)
        return nil unless @not_applied_reason.nil?

        raise TestSelectionRefused, @message.to_s.empty? ? FALLBACK_REFUSAL_MESSAGE : @message if refused?

        if @selection == 'empty'
          # A collection already empty is left alone: the run is then empty for
          # a reason of its own, and announcing a skip over it would mislead.
          return nil if ids.empty?

          @deselected_count = ids.size
          return Set.new
        end

        return nil unless @selection == 'subset'

        subset = @tests.to_set
        kept = ids.select { |id| subset.include?(id) }
        matched = kept.to_set
        # Identities, not counts, so a repeated id can never stand in for a
        # missing one.
        if matched != subset
          @not_applied_reason =
            matched.empty? ? 'subset_matched_no_collected_test' : 'subset_partly_absent_from_collection'
          return nil
        end

        @kept_count = kept.size
        @deselected_count = ids.size - kept.size
        @kept_tests = kept
        subset
      end

      # The block printed in the gem's "Mergify CI" report: what reduced this
      # run, whether it was deliberate, and whether its green can be trusted.
      # Prose, and no identifier from the API ever reaches it.
      # rubocop:disable-next Metrics/MethodLength
      def report
        if @init_error_msg
          # The error text on its own line: it is what support will ask for,
          # and it usually carries a URL that wrapping would split.
          return block("Mergify couldn't be asked whether this run could be reduced, so the full suite ran.") +
                 "Error: #{@init_error_msg}\n"
        end

        if refused?
          # The server's explanation was printed when the run stopped; the
          # block only says where to look.
          return block('Mergify stopped this run before any test ran; its explanation is in the error above.')
        end

        return block(FULL_RUN_SENTENCES.fetch(@not_applied_reason, UNKNOWN_REASON_SENTENCE)) if @not_applied_reason
        return empty_block if @selection == 'empty'
        return subset_block if @selection == 'subset' && @kept_count

        block(FULL_RUN_SENTENCES.fetch(@reason, UNKNOWN_REASON_SENTENCE))
      end

      private

      def empty_block
        skipped = @deselected_count
        # Nothing was collected: the block is the title alone, rather than a
        # paragraph about skipping "all 0 tests".
        return "#{HEADER}\n" if skipped.zero?

        passed, them =
          skipped == 1 ? ['its only test passed back then', 'it'] : ["all #{skipped} tests passed back then", 'them']
        block("The code under test hasn't changed since the previous attempt of this job, and #{passed}. " \
              "Mergify skipped #{them}: the job is green, and no test was executed.")
      end

      # rubocop:disable-next Metrics/MethodLength
      def subset_block
        failed = @kept_count
        skipped = @deselected_count
        sentence =
          if skipped.zero?
            which, them =
              failed == 1 ? ['its only test failed', 'it'] : ["all #{failed} of its tests failed", 'all of them']
            "The code under test hasn't changed since the previous attempt of this job, where #{which}. " \
              "Mergify re-executed #{them}:"
          else
            those = failed == 1 ? 'that one' : "those #{failed}"
            "The code under test hasn't changed since the previous attempt of this job, where #{failed} of its " \
              "#{count_tests(failed + skipped)} failed. Mergify re-executed only #{those} and skipped the " \
              "#{skipped} that had already passed:"
          end

        lines = @kept_tests.first(LISTED_TESTS_MAX).map { |id| "  #{id}" }
        remaining = @kept_tests.size - LISTED_TESTS_MAX
        lines << "  … and #{remaining} more" if remaining.positive?
        "#{block(sentence)}\n#{lines.join("\n")}\n"
      end

      def count_tests(count)
        count == 1 ? '1 test' : "#{count} tests"
      end

      def block(text)
        "#{HEADER}\n\n#{TestSelection.wrap(text)}\n"
      end

      class << self
        # Greedy word wrap, the way Python's `textwrap.fill` does it for this
        # prose: words are never split, and a word longer than the width sits
        # on a line of its own.
        def wrap(text, width = WRAP_WIDTH)
          lines = []
          text.split.each do |word|
            if lines.empty? || lines.last.length + 1 + word.length > width
              lines << word.dup
            else
              lines.last << ' ' << word
            end
          end
          lines.join("\n")
        end
      end
    end
  end
end
