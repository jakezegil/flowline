/**
 * Test setup for the react project. `findBy*` and `waitFor` wait 5s rather than testing-library's
 * 1s default: under a saturated worker pool on a loaded CI runner, a mocked client's promise chain
 * and React's commits can take longer than 1s. This changes only how long a failing wait takes
 * to fail, not what any test asserts.
 */
import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 5000 });
