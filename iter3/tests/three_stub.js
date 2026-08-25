// humanoid.js / effects.js 가 실제로 쓰는 THREE API만 흉내낸 최소 스텁 (헤드리스 검증용)
class V3 {
  constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
  set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
}
class Euler { constructor(){this.x=0;this.y=0;this.z=0;} }
class Obj3D {
  constructor(){ this.position=new V3(); this.rotation=new Euler(); this.scale=new V3(1,1,1); this.children=[]; this.visible=true; }
  add(c){ this.children.push(c); }
}
class Group extends Obj3D {}
class Mesh extends Obj3D { constructor(g,m){ super(); this.geometry=g; this.material=m; } }
function geo(){ return {}; }
function mat(o){ return Object.assign(this||{}, { opacity:1, transparent:false }, o||{}); }
global.THREE = {
  Group, Mesh, Vector3: V3,
  CylinderGeometry: geo, SphereGeometry: geo, BoxGeometry: geo,
  MeshStandardMaterial: mat, MeshBasicMaterial: mat,
};
global.window = global;
global.performance = { now: () => Date.now() };
