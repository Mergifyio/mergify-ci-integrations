# frozen_string_literal: true

require 'opentelemetry-sdk'

module Mergify
  module RSpec
    class ExportError < StandardError; end

    # A span processor that queues spans in memory and exports them all in one
    # batch when force_flush is called. This avoids HTTP requests during test
    # execution.
    class SynchronousBatchSpanProcessor < OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor
      def initialize(exporter)
        super
        @queue = []
      end

      def on_finish(span)
        return unless span.context.trace_flags.sampled?

        @queue << span.to_span_data
      end

      def force_flush(timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
        spans = @queue.dup
        @queue.clear
        result = @span_exporter.export(spans)
        raise ExportError, 'Failed to export traces' unless result == OpenTelemetry::SDK::Trace::Export::SUCCESS

        OpenTelemetry::SDK::Trace::Export::SUCCESS
      end
    end
  end
end
