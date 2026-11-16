package services

import (
	"errors"
	"github.com/pufferpanel/pufferpanel/v3/models"
	"github.com/pufferpanel/pufferpanel/v3/scopes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Permission struct {
	DB *gorm.DB
}

func (ps *Permission) GetForUser(id uint) ([]*models.Permissions, error) {
	var allPerms []*models.Permissions
	permissions := &models.Permissions{
		UserId: &id,
	}

	err := ps.DB.Preload(clause.Associations).Where(permissions).Find(&allPerms).Error

	return allPerms, err
}

func (ps *Permission) GetForServer(serverId string) ([]*models.Permissions, error) {
	var allPerms []*models.Permissions
	permissions := &models.Permissions{
		ServerIdentifier: &serverId,
	}

	err := ps.DB.Preload(clause.Associations).Where(permissions).Find(&allPerms).Error

	return allPerms, err
}

func (ps *Permission) GetForUserAndServer(userId uint, serverId string) (*models.Permissions, error) {
	var id *string

	if serverId != "" {
		id = &serverId
	}

	permissions := &models.Permissions{
		UserId:           &userId,
		ServerIdentifier: id,
	}

	err := ps.DB.Preload(clause.Associations).Where(map[string]interface{}{
		"user_id":           userId,
		"server_identifier": id,
	}).First(permissions).Error

	if err != nil && errors.Is(err, gorm.ErrRecordNotFound) {
		return permissions, nil
	}

	return permissions, err
}

// CountOtherAdmins reports how many users other than userId hold the global
// admin scope. Global scopes are stored as one comma-separated string per row,
// so we match them in Go to avoid substring hits such as "server.admin".
func (ps *Permission) CountOtherAdmins(userId uint) (int64, error) {
	var all []*models.Permissions
	err := ps.DB.Where("user_id IS NOT NULL AND server_identifier IS NULL").Find(&all).Error
	if err != nil {
		return 0, err
	}

	var count int64
	for _, perms := range all {
		if perms.UserId != nil && *perms.UserId != userId && scopes.ContainsScope(perms.Scopes, scopes.ScopeAdmin) {
			count++
		}
	}
	return count, nil
}

func (ps *Permission) HasPermission(userId uint, serverId string, permission *scopes.Scope) (bool, error) {
	var query *gorm.DB

	if serverId != "" {
		query = ps.DB.Preload(clause.Associations).Where(map[string]interface{}{
			"user_id":           userId,
			"server_identifier": serverId,
		}).Or(map[string]interface{}{
			"user_id":           userId,
			"server_identifier": nil,
		})
	} else {
		query = ps.DB.Preload(clause.Associations).Where(map[string]interface{}{
			"user_id":           userId,
			"server_identifier": nil,
		})
	}

	var perms []*models.Permissions

	err := query.Find(&perms).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		return false, err
	}

	for _, perm := range perms {
		if scopes.ContainsScope(perm.Scopes, permission) {
			return true, nil
		}
	}

	return false, nil
}

func (ps *Permission) GetForClient(id uint) ([]*models.Permissions, error) {
	var allPerms []*models.Permissions
	permissions := &models.Permissions{
		ClientId: &id,
	}

	err := ps.DB.Preload(clause.Associations).Where(permissions).Find(&allPerms).Error

	return allPerms, err
}

func (ps *Permission) GetForClientAndServer(id uint, serverId *string) (*models.Permissions, error) {
	permissions := &models.Permissions{
		ClientId:         &id,
		ServerIdentifier: serverId,
	}

	err := ps.DB.Preload(clause.Associations).Where(permissions).FirstOrCreate(permissions).Error

	return permissions, err
}

func (ps *Permission) UpdatePermissions(perms *models.Permissions) error {
	//update oauth2 with new information
	//TODO: THIS NUKES STUFF IF YOU REMOVE GLOBAL PERMS........
	/*if perms.ShouldDelete() {
		return ps.Remove(perms)
	} else {
		return ps.DB.Save(perms).Error
	}*/

	return ps.DB.Omit(clause.Associations).Save(perms).Error
}

func (ps *Permission) Remove(perms *models.Permissions) error {
	//update oauth2 with new information

	return ps.DB.Omit(clause.Associations).Delete(perms).Error
}
