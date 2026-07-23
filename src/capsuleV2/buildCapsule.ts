// Unversioned product assembly seam.
//
// The implementation evolved from the historical "Capsule v2" milestone, but
// current product code has one capsule implementation. Keep the implementation
// module in place to avoid a risky mechanical move while exposing a neutral
// architectural name to every runtime caller.

export {
  buildCapsuleV2 as buildCapsule,
  type BuildCapsuleV2Input as BuildCapsuleInput,
} from "./buildCapsuleV2";
