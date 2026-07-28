//! The tri-state result every backend fetch resolves to.

/// The outcome of a backend fetch.
///
/// The clients treat the API as *fail-open* and server opt-in/out as a normal
/// state, not an error: an HTTP `402` (no subscription) or `404` (feature not
/// enabled) means the feature is **dormant**, distinct from a genuine failure.
/// Callers surface the [`Failed`](Outcome::Failed) message in their report but
/// otherwise degrade gracefully (empty quarantine, no flaky detection).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome<T> {
    /// The feature is enabled and returned data.
    Ready(T),
    /// The feature is not enabled for this repository (`402`/`404`).
    Dormant,
    /// The call failed; the string is a human-readable message for the report.
    Failed(String),
}

impl<T> Outcome<T> {
    /// The data when [`Ready`](Outcome::Ready), else `None` — both dormant and
    /// failed degrade to "no data".
    #[must_use]
    pub fn into_ready(self) -> Option<T> {
        match self {
            Outcome::Ready(value) => Some(value),
            Outcome::Dormant | Outcome::Failed(_) => None,
        }
    }

    /// Whether the feature is dormant (not enabled server-side).
    #[must_use]
    pub fn is_dormant(&self) -> bool {
        matches!(self, Outcome::Dormant)
    }

    /// The failure message, when the fetch [`Failed`](Outcome::Failed).
    #[must_use]
    pub fn failure(&self) -> Option<&str> {
        match self {
            Outcome::Failed(message) => Some(message),
            Outcome::Ready(_) | Outcome::Dormant => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn into_ready_only_on_ready() {
        assert_eq!(Outcome::Ready(5).into_ready(), Some(5));
        assert_eq!(Outcome::<i32>::Dormant.into_ready(), None);
        assert_eq!(Outcome::<i32>::Failed("boom".to_owned()).into_ready(), None);
    }

    #[test]
    fn dormant_and_failure_accessors() {
        assert!(Outcome::<i32>::Dormant.is_dormant());
        assert!(!Outcome::Ready(1).is_dormant());
        assert_eq!(Outcome::<i32>::Failed("boom".to_owned()).failure(), Some("boom"));
        assert_eq!(Outcome::Ready(1).failure(), None);
    }
}
