"use strict";

const STAIN = 10000022;
const TASH_MURKON = 10000020;
const p = (n) => 30000000 + n;

const CONSTELLATIONS = Object.freeze({
  20000276: [1867, 1868, 1869, 1870, 1871, 1872],
  20000280: [1893, 1894, 1895, 1896, 1897, 1898],
  20000281: [1899, 1900, 1901, 1902, 1903, 1904],
  20000284: [1923, 1924, 1925, 1926, 1927, 1928, 1929, 1930],
  20000287: [1948, 1949, 1950, 1951, 1952, 1953, 1954, 1955],
});

const INTERNAL_EDGES = Object.freeze([
  [1867, 1868], [1868, 1869], [1868, 1871], [1869, 1870], [1870, 1893], [1871, 1872], [1893, 1894], [1894, 1895],
  [1894, 1896], [1894, 1897], [1895, 1896], [1895, 1899], [1896, 1897], [1896, 1898], [1897, 1898], [1899, 1900],
  [1899, 1902], [1899, 1903], [1900, 1901], [1900, 1902], [1901, 1903], [1902, 1904], [1903, 1923], [1923, 1924],
  [1923, 1925], [1924, 1927], [1925, 1926], [1925, 1929], [1926, 1929], [1927, 1928], [1927, 1930], [1928, 1948],
  [1948, 1949], [1948, 1951], [1949, 1950], [1951, 1952], [1951, 1953], [1952, 1955], [1953, 1954], [1954, 1955],
].map(([a, b]) => [p(a), p(b)]));

const EXIT_EDGES = Object.freeze([[p(1867), p(1863)], [p(1872), p(1931)], [p(1898), p(1911)], [p(1904), p(1937)],
  [p(1954), p(1956)], [p(1926), 30004932]]);
const CORRIDOR_EDGES = Object.freeze([[p(1721), p(1957)], [p(1957), p(1956)]]);
const POLICE_EDGES = Object.freeze([[30001718, 30001719], [30001719, p(1721)]]);

function system(id, regionId, constellationId, secClass, factionId = 0) {
  return { id, name: `S${id}`, regionId, constellationId, security: secClass === "lowsec" ? 0.29 : (secClass === "highsec" ? 0.64 : -0.1),
    trueSecurity: secClass === "highsec" ? 0.64 : -0.1, secClass, factionId, position: { x: id, y: 0, z: 0 } };
}

function k3StaticMap(opts = {}) {
  const systems = [];
  for (const [constellationId, ids] of Object.entries(CONSTELLATIONS)) {
    for (const n of ids) systems.push(system(p(n), STAIN, Number(constellationId), "nullsec"));
  }
  systems.push(system(30001718, TASH_MURKON, 20000254, "highsec", 500006));
  systems.push(system(30001719, TASH_MURKON, 20000254, "lowsec", 0));
  systems.push(system(p(1721), TASH_MURKON, 20000900, "lowsec", 500003));
  for (const n of [1863, 1911, 1931, 1937, 1956, 1957]) systems.push(system(p(n), STAIN, 20000999, "nullsec"));
  systems.push(system(30004932, 10000063, 20000998, "nullsec"));
  systems.push(system(30002187, 10000043, 20000322, "highsec", 500003));
  systems.push(system(30003563, 10000043, 20000519, "lowsec", 500003));
  systems.push(system(30003562, 10000043, 20000519, "lowsec", 500003));
  systems.push(system(30004299, 10000054, 20000628, "lowsec", 500003));
  systems.push(system(30004309, 10000054, 20000629, "lowsec", 500003));
  for (const extra of opts.extra || []) systems.push(extra);
  const drop = opts.dropEdge ? `${opts.dropEdge[0]}:${opts.dropEdge[1]}` : null;
  const edges = [...INTERNAL_EDGES.filter(([a, b]) => `${a}:${b}` !== drop), ...EXIT_EDGES, ...CORRIDOR_EDGES, ...POLICE_EDGES];
  const gates = [];
  for (const [a, b] of edges) gates.push({ fromSystemId: a, toSystemId: b }, { fromSystemId: b, toSystemId: a });
  return { systems, gates };
}

module.exports = { k3StaticMap, system, STAIN, CONSTELLATIONS, INTERNAL_EDGES, EXIT_EDGES, CORRIDOR_EDGES };
