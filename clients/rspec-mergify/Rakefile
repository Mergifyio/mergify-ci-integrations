# frozen_string_literal: true

require 'bundler/gem_tasks'
require 'rspec/core/rake_task'

RSpec::Core::RakeTask.new(:spec)

task default: :spec

# Override release task to skip git tag/push (handled by GitHub Releases)
Rake::Task['release:source_control_push'].clear
task 'release:source_control_push'

Rake::Task['release:guard_clean'].clear
task 'release:guard_clean'
