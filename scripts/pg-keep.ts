import EmbeddedPostgres from 'embedded-postgres'
import { rmSync } from 'node:fs'
const D='db/pg-keep-data'
rmSync(D,{recursive:true,force:true})
const pg=new EmbeddedPostgres({databaseDir:D,user:'mjengo',password:'mjengo',port:3112,persistent:false})
await pg.initialise(); await pg.start(); await pg.createDatabase('mjengo_test')
console.log('[pg-keep] READY')
process.on('SIGTERM',async()=>{await pg.stop();process.exit(0)})
setInterval(()=>{},10000)
