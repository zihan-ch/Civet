/**
 * lib.js holds functions that are used inside parser.hera
 *
 * The rules inside parser.hera should be simple and short.
 * Most of the helpers/transforms should make their way into
 * here eventually.
 */

/**
 * Clone an AST node including children (removing parent pointes)
 * This gives refs new identities which may not be what we want.
 *
 * TODO: preserve ref identities
 */
function clone(node) {
  removeParentPointers(node)
  return deepCopy(node)
}

function deepCopy(node) {
  if (node == null) return node
  if (typeof node !== "object") return node

  if (Array.isArray(node)) {
    return node.map(deepCopy)
  }

  // Use from entries to clone objects
  // map the values to clone the children
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      return [key, deepCopy(value)]
    })
  )
}

function removeParentPointers(node) {
  if (node == null) return
  if (typeof node !== "object") return

  // NOTE: Arrays are transparent and skipped when traversing via parent
  if (Array.isArray(node)) {
    for (const child of node) {
      removeParentPointers(child)
    }
    return
  }

  node.parent = null
  if (node.children) {
    for (const child of node.children) {
      removeParentPointers(child)
    }
  }
}

// Gather child nodes that match a predicate
// while recursing into nested expressions
// without recursing into nested blocks/for loops
function gatherNodes(node, predicate) {
  if (node == null) return []

  if (Array.isArray(node)) {
    return node.flatMap((n) => gatherNodes(n, predicate))
  }

  if (predicate(node)) {
    return [node]
  }

  switch (node.type) {
    case "BlockStatement":
      return []
    case "ForStatement":
      // Descend into expressions but not into declarations or the body of the for loop
      const isDec = node.declaration?.type === "Declaration"
      return node.children.flatMap((n) => {
        if (isDec && n === node.declaration) return []
        return gatherNodes(n, predicate)
      })
    default:
      return gatherNodes(node.children, predicate)
  }

  return []
}

// Gather nodes that match a predicate recursing into all unmatched children
// i.e. if the predicate matches a node it is not recursed into further
function gatherRecursive(node, predicate, skipPredicate) {
  if (node == null) return []

  if (Array.isArray(node)) {
    return node.flatMap((n) => gatherRecursive(n, predicate, skipPredicate))
  }

  if (skipPredicate?.(node)) return []

  if (predicate(node)) {
    return [node]
  }

  return gatherRecursive(node.children, predicate, skipPredicate)
}

function gatherRecursiveAll(node, predicate) {
  if (node == null) return []

  if (Array.isArray(node)) {
    return node.flatMap((n) => gatherRecursiveAll(n, predicate))
  }

  const nodes = gatherRecursiveAll(node.children, predicate)
  if (predicate(node)) {
    nodes.push(node)
  }

  return nodes
}

/**
 * Does this expression have an `await` in it and thus needs to be `async`?
 */
function hasAwait(exp) {
  return gatherRecursiveWithinFunction(exp, ({ type }) => type === "Await").length > 0
}

function hasYield(exp) {
  return gatherRecursiveWithinFunction(exp, ({ type }) => type === "Yield").length > 0
}

function isFunction(node) {
  const { type } = node
  return type === "FunctionExpression" || type === "ArrowFunction" ||
    type === "MethodDefinition" || node.async
  // do blocks can be marked async to prevent automatic await
}

function gatherRecursiveWithinFunction(node, predicate) {
  return gatherRecursive(node, predicate, isFunction)
}

// Trims the first single space from the spacing array or node's children if present
// maintains $loc for source maps
function insertTrimmingSpace(target, c) {
  if (!target) return target

  if (Array.isArray(target)) return target.map((e, i) => {
    if (i === 0) return insertTrimmingSpace(e, c)
    return e
  })
  if (target.children) return Object.assign({}, target, {
    children: target.children.map((e, i) => {
      if (i === 0) return insertTrimmingSpace(e, c)
      return e
    })
  })

  if (target.token) return Object.assign({}, target, {
    token: target.token.replace(/^ ?/, c)
  })

  return target
}

// Returns leading space as a string, or undefined if none
function getTrimmingSpace(target) {
  if (!target) return
  if (Array.isArray(target)) return getTrimmingSpace(target[0])
  if (target.children) return getTrimmingSpace(target.children[0])
  if (target.token) return target.token.match(/^ ?/)[0]
}

// Returns whether the expression should be memoized with a ref to
// avoid multiple evaluations.
function needsRef(exp) {
  switch (exp.type) {
    case "Identifier":
    case "Literal":
    case "Ref":
      return false
    default:
      return true
  }
}

// Transform into a ref if needed
function maybeRef(exp, base = "ref") {
  if (!needsRef(exp)) return exp
  return {
    type: "Ref",
    base: base,
    id: base,
  }
}

// Convert (non-Template) Literal to actual JavaScript value
function literalValue(literal) {
  let { raw } = literal
  switch (raw) {
    case "null": return null
    case "true": return true
    case "false": return false
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1)
  }
  const numeric = literal.children.find(
    (child) => child.type === "NumericLiteral"
  )
  if (numeric) {
    raw = raw.replace(/_/g, "")
    const { token } = numeric
    if (token.endsWith("n")) {
      return BigInt(raw.slice(0, -1))
    } else if (token.match(/[\.eE]/)) {
      return parseFloat(raw)
    } else if (token.startsWith("0")) {
      switch (token.charAt(1).toLowerCase()) {
        case "x": return parseInt(raw.replace(/0[xX]/, ""), 16)
        case "b": return parseInt(raw.replace(/0[bB]/, ""), 2)
        case "o": return parseInt(raw.replace(/0[oO]/, ""), 8)
      }
    }
    return parseInt(raw, 10)
  }
  throw new Error("Unrecognized literal " + JSON.stringify(literal))
}

// Construct for loop from RangeLiteral
function forRange(open, forDeclaration, range, stepExp, close) {
  const { start, end, inclusive } = range

  const counterRef = {
    type: "Ref",
    base: "i",
    id: "i",
  }

  let stepRef
  if (stepExp) {
    stepExp = insertTrimmingSpace(stepExp, "")
    stepRef = maybeRef(stepExp, "step")
  }

  const startRef = maybeRef(start, "start")
  const endRef = maybeRef(end, "end")

  const startRefDec = (startRef !== start) ? [startRef, " = ", start, ", "] : []
  const endRefDec = (endRef !== end) ? [endRef, " = ", end, ", "] : []

  let ascDec = [], ascRef, asc
  if (stepRef) {
    if (stepRef !== stepExp) {
      ascDec = [", ", stepRef, " = ", stepExp]
    }
  } else if (start.type === "Literal" && end.type === "Literal") {
    asc = literalValue(start) <= literalValue(end)
  } else {
    ascRef = {
      type: "Ref",
      base: "asc",
      id: "asc",
    }
    ascDec = [", ", ascRef, " = ", startRef, " <= ", endRef]
  }

  let varAssign = [], varLetAssign = varAssign, varLet = varAssign, blockPrefix
  if (forDeclaration?.declare) { // var/let/const declaration of variable
    if (forDeclaration.declare.token === "let") {
      const varName = forDeclaration.children.splice(1)  // strip let
      varAssign = [...insertTrimmingSpace(varName, ""), " = "]
      varLet = [",", ...varName, " = ", counterRef]
    } else { // const or var: put inside loop
      // TODO: missing indentation
      blockPrefix = [
        ["", forDeclaration, " = ", counterRef, ";\n"]
      ]
    }
  } else if (forDeclaration) { // Coffee-style for loop
    varAssign = varLetAssign = [forDeclaration, " = "]
    blockPrefix = [
      ["", {
        type: "AssignmentExpression",
        children: [], // Empty assignment to trigger auto-var
        names: forDeclaration.names,
      }]
    ]
  }

  const declaration = {
    type: "Declaration",
    children: ["let ", ...startRefDec, ...endRefDec, counterRef, " = ", ...varLetAssign, startRef, ...varLet, ...ascDec],
    names: forDeclaration?.names,
  }

  const counterPart = inclusive
    ? [counterRef, " <= ", endRef, " : ", counterRef, " >= ", endRef]
    : [counterRef, " < " , endRef, " : ", counterRef, " > " , endRef]

  const condition = stepRef
    ? [stepRef, " !== 0 && (", stepRef, " > 0 ? ", ...counterPart, ")"]
    : ascRef
      ? [ascRef, " ? ", ...counterPart]
      : asc ? counterPart.slice(0, 3) : counterPart.slice(4)

  const increment = stepRef
    ? [...varAssign, counterRef, " += ", stepRef]
    : ascRef
      ? [...varAssign, ascRef, " ? ++", counterRef, " : --", counterRef]
      : [...varAssign, asc ? "++" : "--", counterRef]

  return {
    declaration,
    children: [open, declaration, "; ", ...condition, "; ", ...increment, close],
    blockPrefix,
  }
}

// Adjust a parsed string by escaping newlines
function modifyString(str) {
  // Replace non-escaped newlines with escaped newlines
  // taking into account the possibility of a preceding escaped backslash
  return str.replace(/(^.?|[^\\]{2})(\\\\)*\n/g, '$1$2\\n')
}

// Add quotes around a string to make it a valid JavaScript string,
// escaping any \s
function quoteString(str) {
  str = str.replace(/\\/g, '\\\\')
  if (str.includes('"') && !str.includes("'")) {
    return "'" + str.replace(/'/g, "\\'") + "'"
  } else {
    return '"' + str.replace(/"/g, '\\"') + '"'
  }
}

function processCoffeeInterpolation(s, parts, e, $loc) {
  // Check for no interpolations
  if (parts.length === 0 || (parts.length === 1 && parts[0].token != null)) {
    return {
      type: "StringLiteral",
      token: parts.length ? `"${modifyString(parts[0].token)}"` : '""',
      $loc,
    }
  }

  parts.forEach((part) => {
    // Is a string
    if (part.token) {
      // Escape '${' and '`'
      const str = part.token.replace(/(`|\$\{)/g, "\\$1")
      // Escape non-continuation newlines
      part.token = modifyString(str)
    }
  })

  // Convert to backtick enclosed string
  s.token = e.token = "`"

  return {
    type: "TemplateLiteral",
    children: [s, parts, e],
  }
}

module.exports = {
  clone,
  deepCopy,
  forRange,
  gatherNodes,
  gatherRecursive,
  gatherRecursiveAll,
  gatherRecursiveWithinFunction,
  getTrimmingSpace,
  hasAwait,
  hasYield,
  insertTrimmingSpace,
  isFunction,
  literalValue,
  modifyString,
  processCoffeeInterpolation,
  quoteString,
  removeParentPointers,
}
