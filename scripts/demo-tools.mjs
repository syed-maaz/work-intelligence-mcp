/** This explicit tool surface has no connector, shell, skill or write handler. */
export function demoTools(db, recall) {
  const search = async input => {
    const query = String(input.query ?? input.pattern ?? '').slice(0,200);
    return db.prepare('SELECT source,content,author FROM messages WHERE content LIKE ? LIMIT 10').all('%'+query+'%');
  };
  const def = (name,description,handler) => ({ name, description, category:'auto', posture_eligibility:['generic'], estimated_duration_ms:1000,
    input_schema:{type:'object',properties:{query:{type:'string'},pattern:{type:'string'}}}, handler });
  return [def('wi_search','Search the fictional local SQLite messages only.',search),
    def('fts_search','Search the fictional local SQLite messages only.',search),
    def('brain_recall','Recall fictional local SQLite evidence; palace disabled.',async input => recall({db,pattern:String(input.pattern??input.query??'widget'),limit:10,palace:null}))];
}
