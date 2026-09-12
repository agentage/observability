// Express 4 is installed under an alias so the patch can be proved on both majors.
declare module 'express4' {
  import type expressTypes from 'express';
  const express: typeof expressTypes;
  export default express;
}
