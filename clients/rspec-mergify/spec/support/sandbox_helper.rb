# frozen_string_literal: true

require 'mergify/rspec'
require 'mergify/rspec/ci_insights'
require 'mergify/rspec/formatter'

# Helper module for running RSpec examples in a sandbox and collecting
# recorded spans. Used by integration tests to verify tracing,
# quarantine, and flaky detection behaviour end-to-end.
module SandboxHelper
  # Build a CIInsights instance in test mode with an InMemorySpanExporter.
  # Stubs detection so we get a clean, predictable resource.
  def build_test_ci_insights(quarantined_tests: nil)
    ENV['_RSPEC_MERGIFY_TEST'] = 'true'
    ENV.delete('RSPEC_MERGIFY_DEBUG')

    allow(Mergify::RSpec::Utils).to receive(:in_ci?).and_return(true)
    allow(Mergify::RSpec::Native).to receive_messages(
      detect_repository_name: 'owner/repo',
      detect_attributes: {}
    )

    # The gem's own suite has no repository opted into flaky detection. The
    # client reports dormant, so the detector skips silently -- and nothing
    # reaches the network, which WebMock could no longer prevent anyway now
    # that the request would leave from Rust.
    client = instance_double(Mergify::RSpec::Native::Client, fetch_quarantine: [],
                                                             fetch_flaky_context: nil)
    allow(Mergify::RSpec::Native).to receive(:available?).and_return(true)
    allow(Mergify::RSpec::Native::Client).to receive(:new).and_return(client)

    # A clean, predictable resource: the CI attributes now arrive as one hash
    # from the binding, stubbed empty above, leaving only the framework
    # detector to silence.
    empty_resource = {}
    allow(Mergify::RSpec::Resources::RSpec).to receive(:detect).and_return(empty_resource)

    insights = Mergify::RSpec::CIInsights.new

    # If quarantined tests are provided, replace the quarantined_tests object
    setup_quarantine_double(insights, quarantined_tests) if quarantined_tests

    insights
  end

  # Run examples through the formatter and return finished spans as a hash
  # keyed by span name. Also cleans up the example group from the RSpec world.
  #
  # Usage:
  #   spans, output = run_examples_in_sandbox(insights) do
  #     it("passes") { expect(true).to be true }
  #     it("fails") { expect(false).to be true }
  #   end
  #
  def run_examples_in_sandbox(insights, &)
    Mergify::RSpec.ci_insights = insights

    output = StringIO.new
    formatter = Mergify::RSpec::Formatter.new(output)

    # Define example group dynamically
    group = ::RSpec::Core::ExampleGroup.describe('Sandbox', &)

    begin
      # Start the formatter (session span)
      start_notification = ::RSpec::Core::Notifications::StartNotification.new(group.examples.size)
      formatter.start(start_notification)

      reporter = build_permissive_reporter

      group.examples.each do |example|
        run_sandbox_example(example, group, formatter, insights, reporter)
      end

      # Stop the formatter (finishes session span, prints report)
      stop_notification = double('stop_notification') # rubocop:disable RSpec/VerifiedDoubles
      formatter.stop(stop_notification)

      spans = ci_exporter_to_hash(insights)
      [spans, output.string]
    ensure
      # Clean up the example group from the RSpec world to avoid pollution
      ::RSpec.world.example_groups.delete(group)
    end
  end

  private

  def setup_quarantine_double(insights, quarantined_tests)
    quarantine = double('Quarantine') # rubocop:disable RSpec/VerifiedDoubles
    allow(quarantine).to receive(:include?) { |id| quarantined_tests.include?(id) }
    allow(quarantine).to receive(:mark_as_used)
    allow(quarantine).to receive_messages(report: nil)
    allow(quarantine).to receive(:respond_to?).and_return(false)
    allow(quarantine).to receive(:respond_to?).with(:report).and_return(true)
    insights.instance_variable_set(:@quarantined_tests, quarantine)
  end

  def build_permissive_reporter
    reporter = double('reporter') # rubocop:disable RSpec/VerifiedDoubles
    allow(reporter).to receive_messages(notify: nil, example_started: nil, example_finished: nil,
                                        example_failed: nil, example_passed: nil, example_pending: nil,
                                        deprecation: nil)
    reporter
  end

  def run_sandbox_example(example, group, formatter, insights, reporter)
    # Notify formatter of start
    formatter.example_started(RSpec::Core::Notifications::ExampleNotification.for(example))

    # Apply quarantine before hook if needed
    if insights.quarantined_tests&.include?(example.id)
      insights.quarantined_tests.mark_as_used(example.id)
      example.metadata[:mergify_quarantined] = true
    end

    # Run the example with a real example group instance
    group_instance = group.new
    example.instance_variable_set(:@example_group_instance, group_instance)
    example.run(group_instance, reporter)

    # Apply quarantine after hook: override failed quarantined tests
    if example.metadata[:mergify_quarantined] && example.exception
      example.instance_variable_set(:@exception, nil)
      example.execution_result.status = :pending
      example.execution_result.pending_message = 'Test is quarantined from Mergify Test Insights'
    end

    # Notify formatter of finish based on status
    notification = RSpec::Core::Notifications::ExampleNotification.for(example)
    if example.execution_result.status == :pending
      formatter.example_pending(notification)
    else
      formatter.example_finished(notification)
    end
  end

  def ci_exporter_to_hash(insights)
    insights.recorder.finished_spans.to_h { |span| [span.name, span] }
  end
end
