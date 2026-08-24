// quadtree.js
// Barnes-Hut quadtree for O(n log n) gravitational force approximation.
// Runs inside the physics worker (loaded via importScripts).

class QuadNode {
  // x, y = center of this node's region. size = HALF-width of the region
  // (region spans [x-size, x+size] x [y-size, y+size]).
  constructor(x, y, size) {
    this.x = x;
    this.y = y;
    this.size = size;
    this.mass = 0;
    this.comX = 0; // center of mass
    this.comY = 0;
    this.body = null;   // occupant body when this is a leaf with exactly one body
    this.children = null; // array of 4 QuadNode | null once subdivided
    this.isLeaf = true;
  }
}

const MAX_DEPTH = 50; // safety guard against near-coincident points recursing forever

class Quadtree {
  constructor(x, y, size, theta, softening) {
    this.theta = theta;
    this.softening = softening;
    this.root = new QuadNode(x, y, size);
  }

  insert(body) {
    this._insert(this.root, body, 0);
  }

  _insert(node, body, depth) {
    // Empty node: just occupy it.
    if (node.mass === 0 && node.body === null && node.isLeaf) {
      node.body = body;
      node.mass = body.mass;
      node.comX = body.x;
      node.comY = body.y;
      return;
    }

    if (node.isLeaf) {
      if (depth >= MAX_DEPTH) {
        // Points are (numerically) coincident - merge rather than recurse forever.
        const total = node.mass + body.mass;
        node.comX = (node.comX * node.mass + body.x * body.mass) / total;
        node.comY = (node.comY * node.mass + body.y * body.mass) / total;
        node.mass = total;
        return;
      }
      // Subdivide: push the existing occupant down into a child.
      const old = node.body;
      node.body = null;
      node.isLeaf = false;
      node.children = this._subdivide(node);
      this._insertToChild(node, old, depth + 1);
    }

    // Internal node: fold the new body into the running center-of-mass, then recurse.
    const total = node.mass + body.mass;
    node.comX = (node.comX * node.mass + body.x * body.mass) / total;
    node.comY = (node.comY * node.mass + body.y * body.mass) / total;
    node.mass = total;
    this._insertToChild(node, body, depth + 1);
  }

  _subdivide(node) {
    const s = node.size / 2;
    return [
      new QuadNode(node.x - s, node.y - s, s), // quadrant 0: x<cx, y<cy
      new QuadNode(node.x + s, node.y - s, s), // quadrant 1: x>=cx, y<cy
      new QuadNode(node.x - s, node.y + s, s), // quadrant 2: x<cx, y>=cy
      new QuadNode(node.x + s, node.y + s, s), // quadrant 3: x>=cx, y>=cy
    ];
  }

  _insertToChild(node, body, depth) {
    const idx = (body.x >= node.x ? 1 : 0) + (body.y >= node.y ? 2 : 0);
    this._insert(node.children[idx], body, depth);
  }

  // Accumulate the net gravitational force on `body` from this tree, using
  // the Barnes-Hut approximation: a node is treated as a single point mass
  // whenever (node width / distance) < theta.
  calculateForce(body, G) {
    return this._force(this.root, body, G);
  }

  _force(node, body, G) {
    if (node.mass === 0) return { fx: 0, fy: 0 };

    const dx = node.comX - body.x;
    const dy = node.comY - body.y;
    const distSq = dx * dx + dy * dy;
    const soft = this.softening;
    const distSoft = Math.sqrt(distSq + soft * soft);

    // Note: when `node` is the leaf containing `body` itself, comX/comY ===
    // body.x/body.y, so dx === dy === 0 and the resulting force is exactly
    // zero - no explicit self-exclusion check needed.

    if (node.isLeaf || (node.size * 2) / distSoft < this.theta) {
      const F = (G * node.mass * body.mass) / (distSoft * distSoft);
      return { fx: (F * dx) / distSoft, fy: (F * dy) / distSoft };
    }

    let fx = 0, fy = 0;
    for (let i = 0; i < 4; i++) {
      const c = node.children[i];
      if (c) {
        const f = this._force(c, body, G);
        fx += f.fx;
        fy += f.fy;
      }
    }
    return { fx, fy };
  }
}

// Exposed as a global for classic-script / importScripts usage.
if (typeof self !== 'undefined') self.Quadtree = Quadtree;
if (typeof module !== 'undefined') module.exports = { Quadtree, QuadNode };
