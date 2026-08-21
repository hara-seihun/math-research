-- A citation that renders as nothing is a citation that lied about existing.
-- Pandoc's LaTeX reader parses \cite{key} into a Cite whose display content is
-- the raw macro, and the HTML writer drops raw LaTeX, so without this every
-- reference in a submitted paper silently disappears. There is no bibliography
-- database here and there is not going to be one: a paper is one self-contained
-- artifact, so the key itself is the reference, linked to the anchor that
-- prepareLatex mints for the matching \bibitem.
function Cite(el)
  if #el.citations == 0 then return nil end
  local out = { pandoc.Str("[") }
  for i, c in ipairs(el.citations) do
    if i > 1 then table.insert(out, pandoc.Str(", ")) end
    table.insert(out, pandoc.Link(pandoc.Str(c.id), "#ref-" .. c.id))
  end
  table.insert(out, pandoc.Str("]"))
  return pandoc.Span(out, pandoc.Attr("", { "citation" }))
end
