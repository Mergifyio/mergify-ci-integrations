//! The identity of the set of tests a run collected.
//!
//! Mergify decides whether a rerun may replay a subset of a previous attempt by
//! comparing what the two attempts collected. The comparison needs one value
//! per run rather than the list itself, and that value has to be a *set*
//! identity: two runs that collect the same tests must agree even when pytest,
//! Vitest and Playwright hand their collections over in different orders.
//!
//! Hence [`test_collection_fingerprint`]: SHA-256 each identifier, sort the
//! digests, SHA-256 their concatenation. Sorting the digests -- not the
//! identifiers -- keeps the result independent of the collation the client's
//! language happens to use for strings.
//!
//! It lives here, in the core every client binds to, rather than once per
//! client: a fingerprint two clients compute differently is not a fingerprint,
//! and the server has no way to notice they disagree.

use sha2::{Digest, Sha256};

/// The fingerprint of `test_ids`, as lowercase hexadecimal SHA-256.
///
/// Order-independent, and *not* duplicate-insensitive: the same identifier
/// twice is a different collection from the same identifier once. That rules
/// out combining the digests by XOR, which is cheaper but silently cancels a
/// pair of equal identifiers -- pytest node ids are unique, but the recipe is
/// shared with clients whose identifiers are not.
#[must_use]
pub fn test_collection_fingerprint<I, S>(test_ids: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut digests: Vec<[u8; 32]> = test_ids
        .into_iter()
        .map(|test_id| Sha256::digest(test_id.as_ref().as_bytes()).into())
        .collect();
    digests.sort_unstable();

    let mut hasher = Sha256::new();
    for digest in &digests {
        hasher.update(digest);
    }
    // `{:x}` on the digest is `sha2`'s own lowercase-hex rendering, full width.
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    // sha256(sha256("tests/test_a.py::test_x")), computed independently:
    //   python -c 'import hashlib;
    //     d = hashlib.sha256(b"tests/test_a.py::test_x").digest();
    //     print(hashlib.sha256(d).hexdigest())'
    const ONE_TEST: &str = "e34981c3d93045c70c9e6d00ff46ef54ff4211cb84e7eb79d54aa449ecf5aff6";

    #[test]
    fn fingerprint_does_not_depend_on_collection_order() {
        let ids = ["tests/a.py::test_1", "tests/a.py::test_2", "tests/b.py::test_3"];
        let reversed = ["tests/b.py::test_3", "tests/a.py::test_2", "tests/a.py::test_1"];

        assert_eq!(
            test_collection_fingerprint(ids),
            test_collection_fingerprint(reversed)
        );
    }

    #[test]
    fn a_repeated_identifier_is_not_the_same_collection() {
        // The property a XOR combiner would lose: `["a", "a"]` cancels to the
        // empty collection there, and to a distinct value here.
        assert_ne!(
            test_collection_fingerprint(["a", "a"]),
            test_collection_fingerprint(["a"])
        );
        assert_ne!(
            test_collection_fingerprint(["a", "a"]),
            test_collection_fingerprint(Vec::<String>::new())
        );
    }

    #[test]
    fn different_collections_fingerprint_differently() {
        assert_ne!(
            test_collection_fingerprint(["tests/a.py::test_1"]),
            test_collection_fingerprint(["tests/a.py::test_2"])
        );
        assert_ne!(
            test_collection_fingerprint(["tests/a.py::test_1"]),
            test_collection_fingerprint(["tests/a.py::test_1", "tests/a.py::test_2"])
        );
    }

    #[test]
    fn the_empty_collection_fingerprints_to_the_empty_sha256() {
        // sha256(b"") -- nothing is concatenated, so the outer hash is fed
        // nothing. A run that collected no test still has a stable identity.
        assert_eq!(
            test_collection_fingerprint(Vec::<String>::new()),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn the_recipe_is_pinned_to_a_known_value() {
        // Pins the recipe itself, so a change to it has to be deliberate: the
        // engine and every other client compute this same value, and a silent
        // change makes every stored fingerprint unmatchable.
        assert_eq!(
            test_collection_fingerprint(["tests/test_a.py::test_x"]),
            ONE_TEST
        );
    }
}
