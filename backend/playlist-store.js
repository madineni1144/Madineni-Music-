"use strict";

/**
 * Delete a playlist and its song links atomically.
 *
 * One client is checked out of the pool and used for BEGIN, both DELETEs,
 * COMMIT and ROLLBACK, then always released. Returns the deleted playlist
 * row ({id, name}) or null when it did not exist.
 */
async function deletePlaylist(pool, playlistId) {
  const client = await pool.connect();
  let discardConnection = false;

  try {
    await client.query("BEGIN");

    await client.query(
      "DELETE FROM playlist_songs WHERE playlist_id = $1",
      [playlistId]
    );

    const result = await client.query(
      "DELETE FROM playlists WHERE id = $1 RETURNING id, name",
      [playlistId]
    );

    await client.query("COMMIT");

    return result.rows[0] || null;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // The connection state is unknown: tell the pool to discard it.
      discardConnection = true;
      console.error("Rollback failed:", rollbackError.message);
    }
    throw error;
  } finally {
    client.release(discardConnection);
  }
}

module.exports = { deletePlaylist };
