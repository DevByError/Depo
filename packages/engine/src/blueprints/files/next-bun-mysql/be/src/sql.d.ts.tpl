/** SQL files imported as text (import schema from "./schema.sql" with { type: "text" }). */
declare module "*.sql" {
  const text: string;
  export default text;
}
