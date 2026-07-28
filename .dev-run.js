const fs=require("fs");
for(const line of fs.readFileSync(".env.local","utf8").split("\n")){
  const m=line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if(m) process.env[m[1]]=m[2];
}
const{spawn}=require("child_process");
const p=spawn("npx",["next","dev","-p","3000"],{stdio:"inherit",env:process.env});
p.on("exit",c=>process.exit(c));
