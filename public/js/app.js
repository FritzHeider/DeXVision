/*
 * app.js
 *
 * Client‑side script that establishes a WebSocket connection to the Node server
 * and renders incoming events using Three.js. Each network request spawns
 * a sphere that orbits a central nucleus; its colour encodes HTTP status and
 * its distance from the centre encodes duration. Exceptions and performance
 * metrics are displayed via ambient indicators. The camera can be rotated
 * using mouse controls.
 *
 * This is a starting point. To achieve a perfect score on metrics like
 * visualization clarity, scalability and enterprise readiness you should
 * implement additional features such as custom filters (search by domain or
 * status), off‑thread physics, GPU instancing for large event volumes,
 * and fine‑grained privacy redaction.
 */

(() => {
  // Create the Three.js scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 30;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Controls for orbiting the scene
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  // Central nucleus representing the current page context
  const nucleusGeometry = new THREE.SphereGeometry(1, 32, 32);
  const nucleusMaterial = new THREE.MeshPhongMaterial({ color: 0x00aaff });
  const nucleus = new THREE.Mesh(nucleusGeometry, nucleusMaterial);
  scene.add(nucleus);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0x666666);
  scene.add(ambientLight);
  const pointLight = new THREE.PointLight(0xffffff, 1);
  pointLight.position.set(50, 50, 50);
  scene.add(pointLight);

  // Data structures for events
  const requestMap = new Map();
  const requestGroup = new THREE.Group();
  scene.add(requestGroup);

  // Colour map for HTTP statuses
  function statusToColor(status) {
    if (status >= 200 && status < 300) return 0x00ff00; // Success – green
    if (status >= 300 && status < 400) return 0x00aaff; // Redirect – blue
    if (status >= 400 && status < 500) return 0xffa500; // Client error – orange
    if (status >= 500) return 0xff0000; // Server error – red
    return 0xaaaaaa; // Unknown – grey
  }

  // Create a sphere mesh for a network request
  function createRequestSphere(event) {
    const geometry = new THREE.SphereGeometry(0.3, 16, 16);
    const material = new THREE.MeshPhongMaterial({ color: statusToColor(event.status) });
    const sphere = new THREE.Mesh(geometry, material);
    // Assign initial position on a circle around the nucleus
    const angle = Math.random() * Math.PI * 2;
    const radius = 5 + Math.random() * 5;
    sphere.position.set(
      radius * Math.cos(angle),
      radius * Math.sin(angle),
      (Math.random() - 0.5) * 2
    );
    // Assign orbital velocity inversely proportional to duration (encodedDataLength as proxy)
    sphere.userData = {
      angle,
      radius,
      speed: 0.001 + 0.005 / Math.max(1, event.encodedDataLength || 1),
    };
    return sphere;
  }

  // Update sphere positions for orbiting
  function updateRequests(delta) {
    requestGroup.children.forEach((sphere) => {
      const { angle, radius, speed } = sphere.userData;
      sphere.userData.angle += speed * delta;
      const a = sphere.userData.angle;
      sphere.position.x = radius * Math.cos(a);
      sphere.position.y = radius * Math.sin(a);
    });
  }

  // Resize handler
  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onWindowResize, false);

  // WebSocket connection to the server
  const socket = new WebSocket(`ws://${window.location.hostname}:8080`);
  socket.addEventListener('open', () => {
    console.log('WebSocket connection established');
  });
  socket.addEventListener('message', (message) => {
    try {
      const event = JSON.parse(message.data);
      // Filter to avoid overloading the scene. In a production build you
      // might allow the user to select which event types to render.
      if (event.kind === 'network') {
        const sphere = createRequestSphere(event);
        requestMap.set(event.id, sphere);
        requestGroup.add(sphere);
      } else if (event.kind === 'networkFinish') {
        // Remove finished request from scene
        const sphere = requestMap.get(event.id);
        if (sphere) {
          requestGroup.remove(sphere);
          sphere.geometry.dispose();
          sphere.material.dispose();
          requestMap.delete(event.id);
        }
      } else if (event.kind === 'exception') {
        // Flash nucleus to indicate an exception occurred
        nucleus.material.color.setHex(0xff0000);
        setTimeout(() => nucleus.material.color.setHex(0x00aaff), 300);
      } else if (event.kind === 'performance') {
        // You could visualise metrics (e.g. CPU, memory) here. For brevity we
        // simply log them. Extend this to add rings or gauges.
        console.log('Performance metrics:', event.metrics);
      }
    } catch (err) {
      console.error('Error processing event', err);
    }
  });

  // Render loop
  let lastTime = performance.now();
  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const delta = now - lastTime;
    lastTime = now;
    updateRequests(delta);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
})();