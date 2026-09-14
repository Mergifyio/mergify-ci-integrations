# frozen_string_literal: true

require 'opentelemetry-sdk'
require_relative 'native'

module Mergify
  module RSpec
    # An OpenTelemetry exporter that hands finished spans to the Rust client.
    #
    # This is the same trace, over the same wire format, sent by the code every
    # Mergify test client shares -- retries, gzip, the size limit and the
    # endpoint all belong to one implementation now rather than four. The SDK
    # still builds the spans; that changes in a later step.
    class RustTraceExporter
      SUCCESS = OpenTelemetry::SDK::Trace::Export::SUCCESS
      FAILURE = OpenTelemetry::SDK::Trace::Export::FAILURE

      # A root span's parent is the all-zero id, which is the SDK's way of
      # saying "none"; the wire format wants the field absent instead.
      NO_PARENT = OpenTelemetry::Trace::INVALID_SPAN_ID

      def initialize(client)
        @client = client
      end

      def export(spans, timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
        spans = spans.to_a
        return SUCCESS if spans.empty?

        @client.upload_trace(resource_attributes(spans.first), spans.map { |span| span_hash(span) })
        SUCCESS
      rescue Native::ApiError => e
        # The processor turns this into the message the formatter prints; an
        # unreported run is worth saying out loud, but not worth failing the
        # suite over.
        warn("Mergify: could not upload traces: #{e.message}") if ENV.key?('RSPEC_MERGIFY_DEBUG')
        FAILURE
      end

      def force_flush(timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
        SUCCESS
      end

      def shutdown(timeout: nil) # rubocop:disable Lint/UnusedMethodArgument
        SUCCESS
      end

      private

      # Every span in a batch carries the same resource, so the first one speaks
      # for all of them -- which is also how the wire format represents it.
      def resource_attributes(span)
        return {} unless span.resource

        span.resource.attribute_enumerator.to_h.transform_keys(&:to_s)
      end

      # rubocop:disable-next Metrics/MethodLength
      def span_hash(span)
        {
          'name' => span.name,
          'trace_id' => span.trace_id,
          'span_id' => span.span_id,
          'parent_span_id' => (span.parent_span_id unless span.parent_span_id == NO_PARENT),
          'start_unix_nano' => span.start_timestamp,
          'end_unix_nano' => span.end_timestamp,
          'attributes' => (span.attributes || {}).transform_keys(&:to_s),
          'status' => status_name(span.status),
          'status_message' => span.status&.description
        }.compact
      end

      def status_name(status)
        case status&.code
        when OpenTelemetry::Trace::Status::OK then 'ok'
        when OpenTelemetry::Trace::Status::ERROR then 'error'
        else 'unset'
        end
      end
    end
  end
end
