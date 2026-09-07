# frozen_string_literal: true

require 'mkmf'
require 'rb_sys/mkmf'

# Emits lib/mergify/rspec/mergify_ci.<dlext>; the gem's loader shim requires it
# from there, preferring a per-Ruby copy when the packaged gem ships one.
create_rust_makefile('mergify/rspec/mergify_ci')
