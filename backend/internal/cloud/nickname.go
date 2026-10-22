package cloud

import (
	"errors"
	"strings"
	"unicode"

	"github.com/importcjj/sensitive"
)

const (
	minNicknameRunes = 2
	maxNicknameRunes = 12
)

var (
	errNicknameLength  = errors.New("nickname must contain 2 to 12 characters")
	errNicknameFormat  = errors.New("nickname may only contain letters, numbers, hyphens, and underscores")
	errNicknameBlocked = errors.New("nickname contains unavailable words")
	nicknameFilter     = newNicknameFilter()
)

func newNicknameFilter() *sensitive.Filter {
	filter := sensitive.New()
	// Keep this list focused on text that should not appear in a public nickname. The
	// dependency supplies the matcher; the project owns the vocabulary and its updates.
	filter.AddWord(
		"管理员", "官方客服", "系统消息",
		"外挂", "代练", "开挂",
		"傻逼", "傻b", "操你", "草泥马", "去死",
	)
	return filter
}

// validateNickname applies the same public-name rules to saved profiles and connection
// parameters. Connection handling falls back to a generated name when this rejects input;
// profile.save returns the error to the UI.
func validateNickname(raw string) (string, error) {
	value := strings.TrimSpace(strings.ReplaceAll(raw, "\x00", ""))
	runes := []rune(value)
	if len(runes) < minNicknameRunes || len(runes) > maxNicknameRunes {
		return "", errNicknameLength
	}
	for _, character := range runes {
		if unicode.IsLetter(character) || unicode.IsDigit(character) || character == '-' || character == '_' {
			continue
		}
		return "", errNicknameFormat
	}

	normalised := normaliseForNicknameFilter(value)
	if ok, _ := nicknameFilter.Validate(normalised); !ok {
		return "", errNicknameBlocked
	}
	return value, nil
}

func normaliseForNicknameFilter(value string) string {
	var builder strings.Builder
	for _, character := range strings.ToLower(value) {
		// Fold full-width ASCII so a full-width spelling reaches the same matches.
		if character >= '！' && character <= '～' {
			character -= '！' - '!'
		}
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			builder.WriteRune(character)
		}
	}
	return builder.String()
}
