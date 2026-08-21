/-
Declaration dumper: the index behind `search_decls`.

Imports already-built modules and writes one JSON object per declaration —
name, module, pretty-printed statement, whether its type is a proposition —
so the ledger can answer "what is there to use?" from Postgres in a
millisecond instead of a twenty-second kernel round trip.

  lean --run DumpDecls.lean <modules-file> <out.jsonl>

<modules-file> is one module name per line, and only constants belonging to
those modules are written: dependencies are imported so the modules elaborate
and pretty-print, not to be re-indexed by every batch that pulls them in.
tools/index-decls.sh is what splits a library into batches and runs them in
parallel.

MathlibPlus contains modules that declare the same name as another module,
and importing two of those together is a hard error. This exits with status 2
when the batch cannot be imported at all, which is what tools/index-decls.sh
bisects on: a fresh process per half, because an environment that failed to
import is not something to keep around and retry inside.
-/
import Lean

open Lean Meta

def declKind : ConstantInfo → String
  | .axiomInfo _  => "axiom"
  | .defnInfo _   => "def"
  | .thmInfo _    => "theorem"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _   => "quot"
  | .inductInfo _ => "inductive"
  | .ctorInfo _   => "constructor"
  | .recInfo _    => "recursor"

/-- Pretty-printed types, truncated so one enormous statement cannot become a
    row nobody can read or search. -/
def MAX_STATEMENT : Nat := 4000

/-- Whether a type is a proposition, and how it reads, are both ordinary
    elaboration work, and the heartbeat budget is cumulative over a whole
    `CoreM` run rather than per declaration. Left at its default, an index
    pass dies partway through a library with a deterministic timeout on
    whichever declaration happened to exhaust it. -/
def dumpEnv (env : Environment) (wanted : Std.HashSet Name) (h : IO.FS.Handle) : IO Nat := do
  let ctx : Core.Context := { fileName := "<dump>", fileMap := default, maxHeartbeats := 0 }
  let moduleNames := env.header.moduleNames
  let go : MetaM Nat := do
    let mut written := 0
    for (name, info) in env.constants.toList do
      if name.isInternal then continue
      let some idx := env.getModuleIdxFor? name | continue
      let some modName := moduleNames[idx.toNat]? | continue
      if !wanted.contains modName then continue
      let stmt ← try pure (← ppExpr info.type).pretty catch _ => pure ""
      let isProof ← try isProp info.type catch _ => pure false
      let json := Json.mkObj [
        ("name", Json.str name.toString),
        ("module", Json.str modName.toString),
        ("kind", Json.str (declKind info)),
        ("statement", Json.str (stmt.take MAX_STATEMENT).toString),
        ("is_proof", Json.bool isProof)
      ]
      h.putStrLn json.compress
      written := written + 1
    return written
  let coreM : CoreM Nat := go.run'
  let (n, _) ← coreM.toIO ctx { env := env }
  return n

unsafe def main (argv : List String) : IO UInt32 := do
  let (modulesFile, outFile) ← match argv with
    | m :: o :: _ => pure (m, o)
    | _ => IO.eprintln "usage: lean --run DumpDecls.lean <modules-file> <out.jsonl>"; return 1
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let mods := (← IO.FS.lines modulesFile).filterMap fun line =>
    let t := line.trimAscii.toString
    if t.isEmpty then none else some t.toName
  if mods.isEmpty then IO.eprintln "no modules"; return 1
  let env ← try
      importModules (mods.map fun m => ({ module := m } : Import)) {} (trustLevel := 1024) (loadExts := true)
    catch e =>
      IO.eprintln s!"IMPORT FAILED ({mods.size} module(s)): {toString e}"
      return 2
  let wanted : Std.HashSet Name := mods.foldl (·.insert ·) {}
  IO.FS.withFile outFile .write fun h => do
    -- A module with no declarations is still a complete, useful dump: its
    -- marker tells the loader to remove rows that disappeared since the last
    -- index. Markers also carry the exact generation covered by this process.
    for modName in mods do
      h.putStrLn (Json.mkObj [("module", Json.str modName.toString)]).compress
    let n ← dumpEnv env wanted h
    IO.eprintln s!"wrote {n} declarations from {mods.size} module(s)"
  return 0
