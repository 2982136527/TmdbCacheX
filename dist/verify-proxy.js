import axios from 'axios';
async function main() {
    const PROXY_URL = 'http://localhost:3333';
    console.log('--- Testing TMDB Proxy ---');
    // Test 1: Request without API key (expecting 401 from upstream)
    console.log('\n[Test 1] Requesting /3/movie/550 without API key...');
    try {
        await axios.get(`${PROXY_URL}/3/movie/550`);
        console.log('ERROR: Expected 401, got 200 OK');
    }
    catch (err) {
        if (err.response?.status === 401) {
            console.log('SUCCESS: Got 401 from upstream as expected.');
            console.log('Response:', err.response.data);
        }
        else {
            console.log('ERROR: Expected 401, got', err.response?.status || err.message);
        }
    }
    console.log('\n--- Done ---');
    console.log('Note: To fully test caching, you must use a valid TMDB API Key.');
    console.log(`Example: curl "${PROXY_URL}/3/movie/550?api_key=YOUR_KEY"`);
}
main().catch(console.error);
//# sourceMappingURL=verify-proxy.js.map