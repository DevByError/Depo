// The finish line (install, start the database and the app, open the page after an agent says it
// is done) is tested in finish.test.ts; elsewhere it would start real apps in every task test.
process.env.DEPO_FINISH_LINE ??= "0";
