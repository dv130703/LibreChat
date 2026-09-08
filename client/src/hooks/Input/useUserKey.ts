import { useMemo, useCallback } from 'react';
import { useUserKeyQuery, useUpdateUserKeysMutation } from 'librechat-data-provider/react-query';

const useUserKey = (endpoint: string) => {
  const keyName = endpoint;

  const updateKey = useUpdateUserKeysMutation();
  const checkUserKey = useUserKeyQuery(keyName);

  const getExpiry = useCallback(() => {
    if (checkUserKey.data) {
      return checkUserKey.data.expiresAt || 'never';
    }
  }, [checkUserKey.data]);

  const checkExpiry = useCallback(() => {
    const expiresAt = getExpiry();
    if (!expiresAt) {
      return true;
    }

    const expiresAtDate = new Date(expiresAt);
    if (expiresAtDate < new Date()) {
      return false;
    }
    return true;
  }, [getExpiry]);

  const saveUserKey = useCallback(
    (userKey: string, expiresAt: number | null) => {
      const dateStr = expiresAt ? new Date(expiresAt).toISOString() : '';
      return updateKey.mutateAsync({
        name: keyName,
        value: userKey,
        expiresAt: dateStr,
      });
    },
    [updateKey, keyName],
  );

  return useMemo(
    () => ({ getExpiry, checkExpiry, saveUserKey }),
    [getExpiry, checkExpiry, saveUserKey],
  );
};

export default useUserKey;
