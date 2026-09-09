# frozen_string_literal: true

require 'securerandom'

module Mergify
  module RSpec
    # The little of OpenTelemetry this plugin actually used.
    #
    # A test run needs identifiers, a start and an end, some attributes and a
    # status -- and the shared Rust client does the rest: the wire format, the
    # compression, the retries, the size limit. The SDK brought samplers,
    # context propagation machinery, batch processors and an exporter registry
    # to do the part that fits here, and its dependency tree landed in every
    # consumer's bundle. So the spans are assembled directly.
    module Trace
      # W3C traceparent: version-traceid-spanid-flags, all lowercase hex.
      TRACEPARENT = /\A00-(?<trace_id>[0-9a-f]{32})-(?<span_id>[0-9a-f]{16})-[0-9a-f]{2}\z/

      # A span being recorded, and once finished, the record itself.
      class Span
        attr_reader :name, :trace_id, :span_id, :parent_span_id, :attributes
        attr_accessor :status, :status_message

        def initialize(name:, trace_id:, span_id:, parent_span_id: nil, attributes: {})
          @name = name
          @trace_id = trace_id
          @span_id = span_id
          @parent_span_id = parent_span_id
          @attributes = attributes.transform_keys(&:to_s)
          @status = 'unset'
          @status_message = nil
          @start_unix_nano = Trace.now_unix_nano
          @end_unix_nano = nil
        end

        # Ids travel as bytes and are read as hex -- in a traceparent, in a
        # backend URL, in a log line.
        def hex_trace_id
          @trace_id.unpack1('H*')
        end

        def hex_span_id
          @span_id.unpack1('H*')
        end

        def set_attribute(key, value)
          @attributes[key.to_s] = value
        end

        def error!(message)
          @status = 'error'
          @status_message = message
        end

        def ok!
          @status = 'ok'
        end

        def finish
          @end_unix_nano ||= Trace.now_unix_nano
          self
        end

        # The shape the binding accepts, which is the wire format's own.
        # rubocop:disable-next Metrics/MethodLength
        def to_h
          {
            'name' => @name,
            'trace_id' => @trace_id,
            'span_id' => @span_id,
            'parent_span_id' => @parent_span_id,
            'start_unix_nano' => @start_unix_nano,
            'end_unix_nano' => @end_unix_nano || Trace.now_unix_nano,
            'attributes' => @attributes,
            'status' => @status,
            'status_message' => @status_message
          }.compact
        end
      end

      # Collects a run's spans and hands them to the client in one upload.
      #
      # Deliberately not streaming: a suite's spans are worth one request at the
      # end, and exporting mid-run would put HTTP in the middle of the thing
      # being timed. That was already why the gem replaced the SDK's batch
      # processor with its own.
      class Recorder
        attr_reader :resource_attributes, :finished_spans, :trace_id

        # `traceparent` is the W3C header a caller can hand down to put this
        # run inside a trace it already started; the session span then hangs off
        # that caller's span rather than starting a trace of its own.
        def initialize(resource_attributes: {}, traceparent: nil)
          @resource_attributes = resource_attributes.transform_keys(&:to_s)
          inherited = Trace.parse_traceparent(traceparent)
          @trace_id = inherited ? inherited.first : Trace.generate_trace_id
          @root_parent_span_id = inherited&.last
          @finished_spans = []
        end

        def start_span(name, parent: nil, attributes: {})
          Span.new(
            name: name,
            trace_id: @trace_id,
            span_id: Trace.generate_span_id,
            parent_span_id: parent&.span_id || @root_parent_span_id,
            attributes: attributes
          )
        end

        def record(span)
          @finished_spans << span.finish
          span
        end

        def clear
          @finished_spans = []
        end
      end

      class << self
        def now_unix_nano
          (Time.now.to_r * 1_000_000_000).to_i
        end

        def generate_trace_id
          SecureRandom.bytes(16)
        end

        def generate_span_id
          SecureRandom.bytes(8)
        end

        # The trace this run belongs to, when a parent handed one down.
        # Returns [trace_id, parent_span_id] as raw bytes, or nil.
        def parse_traceparent(header)
          match = TRACEPARENT.match(header.to_s)
          return nil unless match

          [[match[:trace_id]].pack('H*'), [match[:span_id]].pack('H*')]
        end
      end
    end
  end
end
